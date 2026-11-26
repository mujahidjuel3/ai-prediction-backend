import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, RiskLevel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { MlClientService, MlPredictionResult } from '../ml/ml-client.service';

const DEMO_DISCLAIMER =
  'DEMO / SYNTHETIC: These outputs are from a synthetic academic model for semester demonstration only. They are not institutionally validated student risk predictions.';

const FEATURE_KEYS = [
  'attendance',
  'prior_gpa',
  'quiz_avg',
  'midterm',
  'assignment_avg',
  'assessment_avg',
] as const;

type FeatureMap = Record<(typeof FEATURE_KEYS)[number], number>;

@Injectable()
export class DemoPredictionService {
  private readonly logger = new Logger(DemoPredictionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ml: MlClientService,
    private readonly config: ConfigService,
  ) {}

  isEnabled(): boolean {
    return this.config.get<boolean>('DEMO_PREDICTION_ENABLED') === true;
  }

  async status() {
    const probe = this.config.get<boolean>('ML_INTEGRATION_ENABLED')
      ? await this.ml.probe()
      : { reachable: false as const, error: 'ML_INTEGRATION_ENABLED is false' };
    return {
      demoPredictionEnabled: this.isEnabled(),
      mlIntegrationEnabled: this.config.get<boolean>('ML_INTEGRATION_ENABLED') === true,
      universityPolicyApproved: this.config.get<boolean>('ML_UNIVERSITY_POLICY_APPROVED') === true,
      predictionPersistenceEnabled: this.config.get<boolean>('ML_PREDICTION_PERSISTENCE_ENABLED') === true,
      generationEnabled: false,
      disclaimer: DEMO_DISCLAIMER,
      mlService: probe.reachable
        ? { reachable: true, ...probe.ready }
        : { reachable: false, error: probe.error },
    };
  }

  /**
   * Runs synthetic_demo inference for active students that have academic summaries
   * (or derived scores) and persists predictions labeled DEMO / SYNTHETIC.
   * Does not send email. Does not open production generation gates.
   */
  async generateDemoPredictions(actorId: string, termId?: string) {
    if (!this.isEnabled()) {
      throw new ServiceUnavailableException({
        code: 'DEMO_PREDICTION_DISABLED',
        message: 'Demo prediction workflow is disabled. Set DEMO_PREDICTION_ENABLED=true for synthetic demos only.',
        disclaimer: DEMO_DISCLAIMER,
      });
    }
    if (this.config.get<boolean>('ML_INTEGRATION_ENABLED') !== true) {
      throw new ServiceUnavailableException({
        code: 'ML_INTEGRATION_DISABLED',
        message: 'Enable ML_INTEGRATION_ENABLED and point ML_SERVICE_URL at the synthetic_demo FastAPI service.',
        disclaimer: DEMO_DISCLAIMER,
      });
    }

    const probe = await this.ml.probe();
    if (!probe.reachable || !probe.ready?.modelAvailable) {
      throw new ServiceUnavailableException({
        code: 'ML_UNAVAILABLE',
        message: probe.error ?? 'ML service unreachable or model unavailable',
        disclaimer: DEMO_DISCLAIMER,
        mlService: probe.reachable ? { reachable: true, ...probe.ready } : { reachable: false, error: probe.error },
      });
    }
    if (!probe.ready.isSynthetic && probe.ready.operatingMode !== 'synthetic_demo') {
      throw new ServiceUnavailableException({
        code: 'DEMO_REQUIRES_SYNTHETIC_MODE',
        message: 'Demo workflow only accepts synthetic_demo ML artifacts. Production prediction mode is not enabled.',
        disclaimer: DEMO_DISCLAIMER,
      });
    }

    const term = termId
      ? await this.prisma.academicTerm.findUnique({ where: { id: termId } })
      : await this.prisma.academicTerm.findFirst({ orderBy: { startsAt: 'desc' } });
    if (!term) throw new BadRequestException('No academic term available for demo predictions');

    const students = await this.prisma.student.findMany({
      where: { status: 'ACTIVE' },
      select: {
        id: true,
        studentNumber: true,
        name: true,
        summaries: {
          where: { termId: term.id },
          orderBy: { calculatedAt: 'desc' },
          take: 1,
        },
      },
      take: 200,
    });

    if (!students.length) {
      throw new BadRequestException('No active students found for demo predictions');
    }

    const meta = await this.ml.getModelMetadata().catch(() => null);
    const modelVersionLabel = String(
      (meta?.modelVersion as string | undefined) ?? probe.ready.modelVersion ?? `synthetic-demo-${Date.now()}`,
    );
    const artifactSha =
      typeof meta?.modelSha256 === 'string' && /^[a-f0-9]{64}$/i.test(meta.modelSha256)
        ? meta.modelSha256
        : '0'.repeat(64);

    const modelVersion = await this.prisma.modelVersion.upsert({
      where: { version: modelVersionLabel },
      create: {
        version: modelVersionLabel,
        artifactSha256: artifactSha,
        featureSchema: { features: [...FEATURE_KEYS], origin: 'SYNTHETIC_DEMO' },
        metrics: {
          isSynthetic: true,
          operatingMode: 'synthetic_demo',
          disclaimer: DEMO_DISCLAIMER,
          ...(meta?.metrics && typeof meta.metrics === 'object' ? { training: meta.metrics } : {}),
        },
        targetDefinition:
          typeof meta?.targetDefinition === 'string'
            ? meta.targetDefinition
            : 'Synthetic demo binary at-risk label (~4-week horizon). DEMO / SYNTHETIC only.',
        active: true,
      },
      update: {
        active: true,
        metrics: {
          isSynthetic: true,
          operatingMode: 'synthetic_demo',
          disclaimer: DEMO_DISCLAIMER,
        },
      },
    });

    await this.prisma.modelVersion.updateMany({
      where: { id: { not: modelVersion.id }, active: true },
      data: { active: false },
    });

    const created: Array<{ studentId: string; predictionId: string; riskLevel: RiskLevel; probability: number | null }> = [];
    const errors: Array<{ studentId: string; error: string }> = [];

    for (const student of students) {
      try {
        const features = await this.buildFeatures(student.id, term.id, student.summaries[0]);
        const result = await this.ml.predict(features);
        if (!result.isSynthetic && result.operatingMode !== 'synthetic_demo') {
          errors.push({ studentId: student.id, error: 'Refused non-synthetic ML result' });
          continue;
        }
        const risk = this.mapRisk(result);
        const positiveProb = this.positiveProbability(result);
        const explanation = {
          label: 'DEMO / SYNTHETIC',
          isSynthetic: true,
          disclaimer: DEMO_DISCLAIMER,
          contributingIndicators: features,
          prediction: result.prediction,
          probabilities: result.probabilities ?? null,
          operatingMode: result.operatingMode,
        };
        const prediction = await this.prisma.prediction.create({
          data: {
            studentId: student.id,
            termId: term.id,
            modelVersionId: modelVersion.id,
            riskLevel: risk,
            probability: positiveProb === null ? null : new Prisma.Decimal(positiveProb.toFixed(7)),
            featureSnapshot: { ...features, demoLabel: 'DEMO / SYNTHETIC', isSynthetic: true },
            explanation: explanation as unknown as Prisma.InputJsonValue,
          },
        });
        created.push({
          studentId: student.id,
          predictionId: prediction.id,
          riskLevel: risk,
          probability: positiveProb,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'inference failed';
        this.logger.warn(`Demo prediction failed for student ${student.id}: ${message}`);
        errors.push({ studentId: student.id, error: message });
      }
    }

    await this.prisma.auditLog.create({
      data: {
        actorId,
        action: 'DEMO_PREDICTION_GENERATE',
        entityType: 'ModelVersion',
        entityId: modelVersion.id,
        changes: {
          termId: term.id,
          created: created.length,
          errors: errors.length,
          isSynthetic: true,
          disclaimer: DEMO_DISCLAIMER,
        },
      },
    });

    return {
      disclaimer: DEMO_DISCLAIMER,
      isSynthetic: true,
      term: { id: term.id, code: term.code, label: term.label },
      modelVersion: { id: modelVersion.id, version: modelVersion.version },
      createdCount: created.length,
      errorCount: errors.length,
      created,
      errors,
    };
  }

  async demoSummary(termId?: string) {
    const versions = await this.prisma.modelVersion.findMany({ select: { id: true, metrics: true } });
    const syntheticVersionIds = versions
      .filter((v) => Boolean((v.metrics as { isSynthetic?: boolean } | null)?.isSynthetic))
      .map((v) => v.id);
    const where: Prisma.PredictionWhereInput = {
      ...(termId ? { termId } : {}),
      ...(syntheticVersionIds.length ? { modelVersionId: { in: syntheticVersionIds } } : { id: '00000000-0000-0000-0000-000000000000' }),
    };
    const [totalStudents, byRisk, latest] = await Promise.all([
      this.prisma.student.count({ where: { status: 'ACTIVE' } }),
      syntheticVersionIds.length
        ? this.prisma.prediction.groupBy({ by: ['riskLevel'], where, _count: true })
        : Promise.resolve([] as Array<{ riskLevel: RiskLevel; _count: number }>),
      syntheticVersionIds.length
        ? this.prisma.prediction.findMany({
            where,
            orderBy: { generatedAt: 'desc' },
            take: 20,
            include: {
              student: { select: { id: true, studentNumber: true, name: true } },
              term: { select: { code: true, label: true } },
              modelVersion: { select: { version: true, targetDefinition: true, metrics: true } },
            },
          })
        : Promise.resolve([]),
    ]);
    const counts = { LOW: 0, MEDIUM: 0, HIGH: 0 } as Record<RiskLevel, number>;
    for (const row of byRisk) counts[row.riskLevel] = row._count;
    return {
      disclaimer: DEMO_DISCLAIMER,
      isSynthetic: true,
      demoData: true,
      totalStudents,
      demoRiskCounts: counts,
      recent: latest.map((p) => ({
        id: p.id,
        riskLevel: p.riskLevel,
        probability: p.probability,
        generatedAt: p.generatedAt,
        student: p.student,
        term: p.term,
        modelVersion: p.modelVersion,
        indicators:
          (p.explanation as { contributingIndicators?: FeatureMap } | null)?.contributingIndicators
          ?? (p.featureSnapshot as FeatureMap | null),
        label: 'DEMO / SYNTHETIC',
      })),
    };
  }

  private async buildFeatures(
    studentId: string,
    termId: string,
    summary?: { gpa: Prisma.Decimal | null; attendancePercent: Prisma.Decimal | null; assessmentAverage: Prisma.Decimal | null } | null,
  ): Promise<FeatureMap> {
    const attendance = summary?.attendancePercent != null ? Number(summary.attendancePercent) : await this.avgAttendance(studentId, termId);
    const priorGpa = summary?.gpa != null ? Number(summary.gpa) : 2.5;
    const assessmentAvg = summary?.assessmentAverage != null ? Number(summary.assessmentAverage) : await this.avgAssessment(studentId, termId);
    const quiz = await this.avgAssessmentByKind(studentId, termId, ['QUIZ', 'quiz', 'Quiz']) ?? assessmentAvg;
    const midterm = await this.avgAssessmentByKind(studentId, termId, ['MIDTERM', 'midterm', 'Midterm', 'EXAM']) ?? assessmentAvg;
    const assignment = await this.avgAssessmentByKind(studentId, termId, ['ASSIGNMENT', 'assignment', 'Assignment', 'HOMEWORK']) ?? assessmentAvg;
    return {
      attendance: this.clamp(attendance, 0, 100),
      prior_gpa: this.clamp(priorGpa, 0, 4),
      quiz_avg: this.clamp(quiz, 0, 100),
      midterm: this.clamp(midterm, 0, 100),
      assignment_avg: this.clamp(assignment, 0, 100),
      assessment_avg: this.clamp(assessmentAvg, 0, 100),
    };
  }

  private async avgAttendance(studentId: string, termId: string): Promise<number> {
    const rows = await this.prisma.attendanceRecord.findMany({
      where: { studentId, offering: { termId } },
      select: { status: true },
      take: 500,
    });
    if (!rows.length) return 75;
    const present = rows.filter((r) => r.status === 'PRESENT' || r.status === 'LATE' || r.status === 'EXCUSED').length;
    return (present / rows.length) * 100;
  }

  private async avgAssessment(studentId: string, termId: string): Promise<number> {
    const scores = await this.prisma.assessmentScore.findMany({
      where: { studentId, assessment: { offering: { termId } }, score: { not: null } },
      select: { score: true, assessment: { select: { maxScore: true } } },
      take: 200,
    });
    if (!scores.length) return 65;
    const pct = scores.map((s) => (Number(s.score) / Number(s.assessment.maxScore)) * 100);
    return pct.reduce((a, b) => a + b, 0) / pct.length;
  }

  private async avgAssessmentByKind(studentId: string, termId: string, kinds: string[]): Promise<number | null> {
    const scores = await this.prisma.assessmentScore.findMany({
      where: {
        studentId,
        score: { not: null },
        assessment: { offering: { termId }, kind: { in: kinds } },
      },
      select: { score: true, assessment: { select: { maxScore: true } } },
      take: 100,
    });
    if (!scores.length) return null;
    const pct = scores.map((s) => (Number(s.score) / Number(s.assessment.maxScore)) * 100);
    return pct.reduce((a, b) => a + b, 0) / pct.length;
  }

  private mapRisk(result: MlPredictionResult): RiskLevel {
    const prob = this.positiveProbability(result);
    if (prob === null) {
      return String(result.prediction) === '1' ? RiskLevel.HIGH : RiskLevel.LOW;
    }
    if (prob >= 0.66) return RiskLevel.HIGH;
    if (prob >= 0.33) return RiskLevel.MEDIUM;
    return RiskLevel.LOW;
  }

  private positiveProbability(result: MlPredictionResult): number | null {
    const probs = result.probabilities;
    if (!probs) return null;
    const raw = probs['1'] ?? probs['true'] ?? probs['at_risk'];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
    return Math.min(1, Math.max(0, raw));
  }

  private clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return (min + max) / 2;
    return Math.min(max, Math.max(min, value));
  }
}
