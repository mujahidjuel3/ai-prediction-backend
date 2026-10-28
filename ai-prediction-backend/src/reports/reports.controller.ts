import { BadRequestException, Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Response } from 'express';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.module';
import { serializeCsv } from '../imports/csv';

@ApiTags('reports') @UseGuards(JwtAuthGuard) @Roles(Role.ADMIN) @Controller('reports')
export class ReportsController {
 constructor(private prisma:PrismaService){}
 @Get('academic-records.csv') async exportRecords(@Query('termId') termId:string|undefined,@Res() res:Response){const [scores,attendance]=await this.prisma.$transaction([
  this.prisma.assessmentScore.findMany({where:termId?{assessment:{offering:{termId}}}:{},take:5001,orderBy:{updatedAt:'desc'},include:{student:{select:{studentNumber:true}},assessment:{include:{offering:{select:{section:true,course:{select:{code:true}},term:{select:{code:true}}}}}}}}),
  this.prisma.attendanceRecord.findMany({where:termId?{offering:{termId}}:{},take:5001,orderBy:{sessionDate:'desc'},include:{student:{select:{studentNumber:true}},offering:{select:{section:true,course:{select:{code:true}},term:{select:{code:true}}}}}}),
 ]);if(scores.length+attendance.length>5000)throw new BadRequestException('Report exceeds 5,000 rows; narrow the term filter');const header=['record_type','student_number','course_code','term_code','section','record_date','attendance_status','assessment_name','assessment_kind','max_score','weight','score'];const rows:unknown[][]=[header,...attendance.map(a=>['attendance',a.student.studentNumber,a.offering.course.code,a.offering.term.code,a.offering.section,a.sessionDate.toISOString().slice(0,10),a.status,'','','','','']),...scores.map(s=>['score',s.student.studentNumber,s.assessment.offering.course.code,s.assessment.offering.term.code,s.assessment.offering.section,'','',s.assessment.name,s.assessment.kind,String(s.assessment.maxScore),s.assessment.weight===null?'':String(s.assessment.weight),s.score===null?'':String(s.score)])];const csv=serializeCsv(rows);res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="academic-records.csv"');res.setHeader('Cache-Control','no-store');return res.send(csv);}
}
