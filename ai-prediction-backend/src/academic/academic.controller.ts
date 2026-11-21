import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Role } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.module';
import { pageQuery } from '../common/pagination';

class TermDto {
  @IsString() @MinLength(2) @MaxLength(40) code!: string;
  @IsString() @MinLength(2) @MaxLength(100) label!: string;
  @IsString() academicYear!: string;
  @IsDateString() startsAt!: string;
  @IsDateString() endsAt!: string;
  @IsOptional() @IsBoolean() active?: boolean;
}
class TermUpdateDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(40) code?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(100) label?: string;
  @IsOptional() @IsString() academicYear?: string;
  @IsOptional() @IsDateString() startsAt?: string;
  @IsOptional() @IsDateString() endsAt?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

@ApiTags('academic') @UseGuards(JwtAuthGuard) @Controller()
export class AcademicController {
  constructor(private prisma: PrismaService) {}

  @Roles(Role.ADMIN, Role.TEACHER, Role.STUDENT) @Get('terms')
  async terms(@Query('page') p?: string, @Query('pageSize') s?: string) {
    const pg = pageQuery(p, s);
    const [data, total] = await this.prisma.$transaction([
      this.prisma.academicTerm.findMany({ skip: pg.skip, take: pg.pageSize, orderBy: { startsAt: 'desc' } }),
      this.prisma.academicTerm.count(),
    ]);
    return { data, meta: { page: pg.page, pageSize: pg.pageSize, total, totalPages: Math.ceil(total / pg.pageSize) } };
  }

  @Roles(Role.ADMIN) @Post('terms')
  async createTerm(@Body() dto: TermDto) {
    if (new Date(dto.endsAt) <= new Date(dto.startsAt)) throw new BadRequestException('Term end must follow term start');
    try {
      return {
        data: await this.prisma.academicTerm.create({
          data: {
            code: dto.code,
            label: dto.label,
            academicYear: dto.academicYear,
            startsAt: new Date(dto.startsAt),
            endsAt: new Date(dto.endsAt),
            active: dto.active ?? false,
          },
        }),
      };
    } catch (error) {
      return this.mapUniqueConflict(error);
    }
  }

  @Roles(Role.ADMIN) @Patch('terms/:id')
  async updateTerm(@Param('id') id: string, @Body() dto: TermUpdateDto) {
    const current = await this.prisma.academicTerm.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Academic term not found');
    const startsAt = dto.startsAt ? new Date(dto.startsAt) : current.startsAt;
    const endsAt = dto.endsAt ? new Date(dto.endsAt) : current.endsAt;
    if (endsAt <= startsAt) throw new BadRequestException('Term end must follow term start');
    try {
      return {
        data: await this.prisma.academicTerm.update({
          where: { id },
          data: {
            ...(dto.code !== undefined ? { code: dto.code } : {}),
            ...(dto.label !== undefined ? { label: dto.label } : {}),
            ...(dto.academicYear !== undefined ? { academicYear: dto.academicYear } : {}),
            ...(dto.startsAt !== undefined ? { startsAt } : {}),
            ...(dto.endsAt !== undefined ? { endsAt } : {}),
            ...(dto.active !== undefined ? { active: dto.active } : {}),
          },
        }),
      };
    } catch (error) {
      return this.mapUniqueConflict(error);
    }
  }

  @Roles(Role.ADMIN, Role.TEACHER, Role.STUDENT) @Get('departments')
  async departments() {
    return { data: await this.prisma.department.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { students: true, teachers: true, courses: true } } } }) };
  }

  @Roles(Role.ADMIN, Role.TEACHER) @Get('courses/catalog')
  async courseCatalog(@CurrentUser() actor: AuthUser, @Query('page') p?: string, @Query('pageSize') s?: string, @Query('departmentId') departmentId?: string) {
    const pg = pageQuery(p, s);
    const where = {
      ...(departmentId ? { departmentId } : {}),
      ...(actor.role === 'TEACHER' ? { offerings: { some: { teacher: { userId: actor.id } } } } : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.course.findMany({ where, skip: pg.skip, take: pg.pageSize, orderBy: { name: 'asc' }, include: { department: true, _count: { select: { offerings: true } } } }),
      this.prisma.course.count({ where }),
    ]);
    return { data, meta: { page: pg.page, pageSize: pg.pageSize, total, totalPages: Math.ceil(total / pg.pageSize) } };
  }

  @Roles(Role.ADMIN, Role.TEACHER) @Get('courses')
  async courses(@CurrentUser() actor: AuthUser, @Query('termId') termId?: string, @Query('departmentId') departmentId?: string) {
    return {
      data: await this.prisma.courseOffering.findMany({
        where: {
          ...(termId ? { termId } : {}),
          ...(departmentId ? { course: { departmentId } } : {}),
          ...(actor.role === 'TEACHER' ? { teacher: { userId: actor.id } } : {}),
        },
        include: {
          course: { include: { department: true } },
          term: true,
          teacher: { select: { id: true, name: true } },
          _count: { select: { enrollments: true } },
        },
        orderBy: { course: { name: 'asc' } },
      }),
    };
  }

  @Roles(Role.ADMIN) @Get('users')
  async users(@Query('q') q?: string, @Query('page') p?: string, @Query('pageSize') s?: string) {
    const pg = pageQuery(p, s);
    const where = q ? { OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { email: { contains: q, mode: 'insensitive' as const } }] } : {};
    const [data, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({ where, select: { id: true, name: true, email: true, role: true, status: true, createdAt: true }, skip: pg.skip, take: pg.pageSize, orderBy: { createdAt: 'desc' } }),
      this.prisma.user.count({ where }),
    ]);
    return { data, meta: { page: pg.page, pageSize: pg.pageSize, total, totalPages: Math.ceil(total / pg.pageSize) } };
  }

  private mapUniqueConflict(error: unknown): never {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'P2002') {
      throw new ConflictException('Academic term code already exists');
    }
    throw error;
  }
}
