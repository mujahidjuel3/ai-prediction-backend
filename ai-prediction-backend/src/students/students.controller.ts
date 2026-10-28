import { BadRequestException, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { PrismaService } from '../prisma/prisma.module';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { pageQuery } from '../common/pagination';

interface TeacherStudentScope {
  offeringIds: string[];
  completeTermIds: string[];
}

@ApiTags('students') @UseGuards(JwtAuthGuard) @Controller('students')
export class StudentsController {
  constructor(private prisma: PrismaService) {}
  @Roles(Role.ADMIN, Role.TEACHER) @Get()
  async list(@CurrentUser() actor:AuthUser,@Query('page') p?: string, @Query('pageSize') s?: string, @Query('q') q?: string, @Query('departmentId') departmentId?: string, @Query('sort') sort = 'name', @Query('order') order = 'asc') {
    const page = pageQuery(p, s); const allowed = ['name', 'studentNumber', 'createdAt'];
    if (!allowed.includes(sort) || !['asc', 'desc'].includes(order)) throw new BadRequestException('Invalid sort options');
    const where = { status: 'ACTIVE' as const, ...(actor.role==='TEACHER'?{enrollments:{some:{status:'ENROLLED' as const,offering:{teacher:{userId:actor.id}}}}}:{}), ...(departmentId ? { departmentId } : {}), ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { studentNumber: { contains: q, mode: 'insensitive' as const } }] } : {}) };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.student.findMany({ where, select: { id: true, userId: true, studentNumber: true, name: true, email: true, departmentId: true, department: { select: { id: true, code: true, name: true } }, enrollmentYear: true, status: true }, orderBy: { [sort]: order }, skip: page.skip, take: page.pageSize }),
      this.prisma.student.count({ where }),
    ]);
    return { data: rows, meta: { page: page.page, pageSize: page.pageSize, total, totalPages: Math.ceil(total / page.pageSize) } };
  }
  @Get('me') async myProfile(@CurrentUser() actor:AuthUser){if(actor.role!=='STUDENT')throw new (await import('@nestjs/common')).ForbiddenException('Student account required');const student=await this.prisma.student.findUnique({where:{userId:actor.id},include:{department:true,enrollments:{include:{offering:{include:{course:true,term:true}}}}}});if(!student)throw new (await import('@nestjs/common')).NotFoundException('Student profile is not linked to this account');return{data:student};}
  @Get('me/records') async myRecords(@CurrentUser() actor:AuthUser){if(actor.role!=='STUDENT')throw new (await import('@nestjs/common')).ForbiddenException('Student account required');const student=await this.prisma.student.findUnique({where:{userId:actor.id},select:{id:true}});if(!student)throw new (await import('@nestjs/common')).NotFoundException('Student profile is not linked to this account');const [attendance,scores]=await this.prisma.$transaction([this.prisma.attendanceRecord.findMany({where:{studentId:student.id},include:{offering:{include:{course:true,term:true}}},orderBy:{sessionDate:'desc'}}),this.prisma.assessmentScore.findMany({where:{studentId:student.id},include:{assessment:{include:{offering:{include:{course:true,term:true}}}}},orderBy:{updatedAt:'desc'}})]);return{data:{attendance,scores}};}
  @Get(':id') async detail(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    let teacherScope: TeacherStudentScope | undefined;
    if (actor.role === Role.STUDENT) {
      const own = await this.prisma.student.findUnique({ where: { userId: actor.id }, select: { id: true } });
      if (!own || own.id !== id) throw new (await import('@nestjs/common')).ForbiddenException('Student access is restricted to the signed-in student');
    } else if (actor.role === Role.TEACHER) {
      teacherScope = await this.teacherStudentScope(actor, id);
    }
    const scopedAcademicRelations = teacherScope ? {
      enrollments: { where: { offeringId: { in: teacherScope.offeringIds } } },
      summaries: { where: { termId: { in: teacherScope.completeTermIds } } },
      predictions: { where: { termId: { in: teacherScope.completeTermIds } } },
      alerts: { where: { termId: { in: teacherScope.completeTermIds } } },
    } : {};
    const student = await this.prisma.student.findUnique({ where: { id }, include: {
      department: true,
      enrollments: { ...scopedAcademicRelations.enrollments, include: { offering: { include: { course: true, term: true } } } },
      summaries: { ...scopedAcademicRelations.summaries, orderBy: { calculatedAt: 'desc' }, take: 20 },
      predictions: { ...scopedAcademicRelations.predictions, orderBy: { generatedAt: 'desc' }, take: 20, include: { modelVersion: { select: { version: true, targetDefinition: true } } } },
      alerts: { ...scopedAcademicRelations.alerts, orderBy: { createdAt: 'desc' }, take: 20 },
    } });
    if (!student) throw new (await import('@nestjs/common')).NotFoundException('Student not found');
    return { data: student };
  }
  @Roles(Role.ADMIN,Role.TEACHER,Role.STUDENT) @Get(':id/records') async records(@Param('id') id: string, @CurrentUser() actor:AuthUser, @Query('termId') termId?: string) {
    let teacherScope: TeacherStudentScope | undefined;
    if(actor.role==='STUDENT'){const own=await this.prisma.student.findUnique({where:{userId:actor.id},select:{id:true}});if(!own||own.id!==id)throw new (await import('@nestjs/common')).ForbiddenException('Records are restricted to the signed-in student');}
    if(actor.role==='TEACHER') teacherScope = await this.teacherStudentScope(actor, id);
    const assessmentScope = teacherScope
      ? { offeringId: { in: teacherScope.offeringIds }, ...(termId ? { offering: { termId } } : {}) }
      : termId ? { offering: { termId } } : undefined;
    const scores = await this.prisma.assessmentScore.findMany({ where: { studentId: id, ...(assessmentScope ? { assessment: assessmentScope } : {}) }, include: { assessment: { include: { offering: { include: { course: true, term: true } } } } }, orderBy: { updatedAt: 'desc' } });
    return { data: scores };
  }

  private async teacherStudentScope(actor: AuthUser, studentId: string): Promise<TeacherStudentScope> {
    const [activeEnrollments, assignedOfferings] = await Promise.all([
      this.prisma.enrollment.findMany({
        where: { studentId },
        select: { offeringId: true, offering: { select: { termId: true } } },
      }),
      this.prisma.courseOffering.findMany({
        where: { teacher: { userId: actor.id }, enrollments: { some: { studentId, status: 'ENROLLED' } } },
        select: { id: true, termId: true },
      }),
    ]);
    if (!assignedOfferings.length) {
      throw new (await import('@nestjs/common')).ForbiddenException('Student is not in an assigned offering');
    }

    const offeringIds = assignedOfferings.map(({ id }) => id);
    const assignedOfferingIds = new Set(offeringIds);
    const offeringsByTerm = new Map<string, string[]>();
    for (const enrollment of activeEnrollments) {
      const termOfferings = offeringsByTerm.get(enrollment.offering.termId) ?? [];
      termOfferings.push(enrollment.offeringId);
      offeringsByTerm.set(enrollment.offering.termId, termOfferings);
    }
    const completeTermIds = [...offeringsByTerm]
      .filter(([, termOfferingIds]) => termOfferingIds.every((offeringId) => assignedOfferingIds.has(offeringId)))
      .map(([termId]) => termId);

    return { offeringIds, completeTermIds };
  }
}
