import { ServiceUnavailableException } from '@nestjs/common';
import { DemoPredictionService } from './demo-prediction.service';

describe('DemoPredictionService', () => {
  const prisma = {
    academicTerm: { findFirst: jest.fn(), findUnique: jest.fn() },
    student: { findMany: jest.fn(), count: jest.fn() },
    modelVersion: { upsert: jest.fn(), updateMany: jest.fn(), findMany: jest.fn() },
    prediction: { create: jest.fn(), groupBy: jest.fn(), findMany: jest.fn() },
    auditLog: { create: jest.fn() },
    attendanceRecord: { findMany: jest.fn() },
    assessmentScore: { findMany: jest.fn() },
  };
  const ml = {
    probe: jest.fn(),
    getModelMetadata: jest.fn(),
    predict: jest.fn(),
  };
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'DEMO_PREDICTION_ENABLED') return true;
      if (key === 'ML_INTEGRATION_ENABLED') return true;
      return false;
    }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('refuses generation when demo flag is off', async () => {
    config.get.mockImplementation((key: string) => key === 'DEMO_PREDICTION_ENABLED' ? false : true);
    const service = new DemoPredictionService(prisma as never, ml as never, config as never);
    await expect(service.generateDemoPredictions('actor')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('refuses non-synthetic ML ready status', async () => {
    config.get.mockImplementation((key: string) => key === 'DEMO_PREDICTION_ENABLED' || key === 'ML_INTEGRATION_ENABLED');
    ml.probe.mockResolvedValue({
      reachable: true,
      ready: { modelAvailable: true, isSynthetic: false, operatingMode: 'production_prediction', status: 'ready', disclaimer: 'x' },
    });
    const service = new DemoPredictionService(prisma as never, ml as never, config as never);
    await expect(service.generateDemoPredictions('actor')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('returns empty demo summary when no synthetic model versions exist', async () => {
    prisma.modelVersion.findMany.mockResolvedValue([]);
    prisma.student.count.mockResolvedValue(3);
    const service = new DemoPredictionService(prisma as never, ml as never, config as never);
    const summary = await service.demoSummary();
    expect(summary.demoData).toBe(true);
    expect(summary.isSynthetic).toBe(true);
    expect(summary.demoRiskCounts).toEqual({ LOW: 0, MEDIUM: 0, HIGH: 0 });
    expect(summary.totalStudents).toBe(3);
    expect(summary.disclaimer).toMatch(/DEMO \/ SYNTHETIC/);
  });
});
