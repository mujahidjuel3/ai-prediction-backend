import { Controller, Get, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser, AuthUser } from './common/decorators/current-user.decorator';
import { Roles } from './common/decorators/roles.decorator';
import { PrismaService } from './prisma/prisma.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
@Controller()
export class AppController {
 constructor(private prisma: PrismaService) {}
 @UseGuards(JwtAuthGuard) @Roles(Role.ADMIN,Role.TEACHER,Role.STUDENT) @Get('dashboard/summary') async summary(@CurrentUser() actor: AuthUser) {
   const studentWhere = actor.role === Role.STUDENT ? { userId: actor.id } : {};
   const [students, departments, teachers, courses, offerings, alerts] = await Promise.all([
     this.prisma.student.count({where:studentWhere}), this.prisma.department.count(), this.prisma.teacher.count(),
     this.prisma.course.count({where:{active:true}}), this.prisma.courseOffering.count(),
     this.prisma.riskAlert.count({where:{status:{in:['OPEN','ACKNOWLEDGED']},...(actor.role===Role.STUDENT?{student:{userId:actor.id}}:{})}}),
   ]);
   return {data:{students,departments,teachers,courses,offerings,openAlerts:alerts}};
 }
}
