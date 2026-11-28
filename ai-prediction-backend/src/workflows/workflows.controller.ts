import { Body, Controller, Get, Headers, Param, Patch, Post, Query, UseGuards, ForbiddenException, NotFoundException, ConflictException, ServiceUnavailableException, BadRequestException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AlertStatus, Role } from '@prisma/client';
import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { pageQuery } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.module';
import { MlClientService } from '../ml/ml-client.service';
import { NotificationEmailService } from './notification-email.service';
import { NotificationGateway } from './notification.gateway';
import { DemoPredictionService } from './demo-prediction.service';

class AlertUpdateDto { @IsIn(['ACKNOWLEDGED','RESOLVED']) status!: AlertStatus; @IsOptional() @IsString() @MaxLength(2000) note?: string; }
class ReviewDto { @IsIn(['CONFIRMED','FALSE_POSITIVE','OVERRIDDEN']) outcome!: string; @IsOptional() @IsString() @MaxLength(2000) rationale?: string; }
class ProfileDto { @IsOptional() @IsString() @MinLength(2) @MaxLength(160) name?:string; @IsOptional() @IsEmail() email?:string; }
class PreferencesDto { @IsOptional() @IsBoolean() inApp?:boolean; @IsOptional() @IsBoolean() email?:boolean; @IsOptional() @IsBoolean() weeklySummary?:boolean; @IsOptional() @IsBoolean() highRiskAlerts?:boolean; @IsOptional() @IsBoolean() attendanceAlerts?:boolean; }
class CreateNotificationDto { @IsUUID() recipientId!:string; @IsString() @MinLength(1) @MaxLength(180) title!:string; @IsString() @MinLength(1) @MaxLength(1000) message!:string; }
class DemoGenerateDto { @IsOptional() @IsUUID() termId?: string; }
class TestEmailDto {
  @IsEmail() to!: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(180) subject?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(1000) message?: string;
}
@ApiTags('alerts', 'predictions', 'notifications', 'profile') @UseGuards(JwtAuthGuard) @Controller()
export class WorkflowsController {
 constructor(
  private prisma: PrismaService,
  private readonly notificationEmail: NotificationEmailService,
  private readonly ml: MlClientService,
  private readonly notificationGateway: NotificationGateway,
  private readonly demoPredictions: DemoPredictionService,
 ) {}
 @Roles(Role.ADMIN,Role.TEACHER) @Get('alerts') async alerts(@CurrentUser() actor:AuthUser,@Query('status') status?:AlertStatus,@Query('page') p?:string,@Query('pageSize') s?:string){const pg=pageQuery(p,s);const where={...(status?{status}:{}),...(actor.role==='TEACHER'?{student:{is:{enrollments:{some:{status:'ENROLLED' as const,offering:{teacher:{userId:actor.id}}}}}}}:{})};const [data,total]=await this.prisma.$transaction([this.prisma.riskAlert.findMany({where,skip:pg.skip,take:pg.pageSize,orderBy:{createdAt:'desc'},include:{student:{select:{id:true,studentNumber:true,name:true}},term:{select:{id:true,label:true}}}}),this.prisma.riskAlert.count({where})]);return{data,meta:{page:pg.page,pageSize:pg.pageSize,total,totalPages:Math.ceil(total/pg.pageSize)}};}
 @Roles(Role.ADMIN,Role.TEACHER) @Patch('alerts/:id') async updateAlert(@Param('id') id:string,@Body() dto:AlertUpdateDto,@CurrentUser() actor:AuthUser){const alert=await this.prisma.riskAlert.findUnique({where:{id},include:{student:{select:{id:true}}}});if(!alert)throw new NotFoundException('Alert not found');if(actor.role==='TEACHER'){const assigned=await this.prisma.courseOffering.count({where:{teacher:{userId:actor.id},enrollments:{some:{studentId:alert.studentId,status:'ENROLLED'}}}});if(!assigned)throw new ForbiddenException('Alert is outside assigned courses');}if(alert.status==='RESOLVED'&&dto.status!=='RESOLVED')throw new ConflictException('Resolved alerts cannot be reopened through this operation');const updated=await this.prisma.$transaction(async tx=>{const saved=await tx.riskAlert.update({where:{id},data:{status:dto.status,resolvedAt:dto.status==='RESOLVED'?new Date():null,resolvedById:dto.status==='RESOLVED'?actor.id:null}});await tx.auditLog.create({data:{actorId:actor.id,action:`ALERT_${dto.status}`,entityType:'RiskAlert',entityId:id,changes:{note:dto.note??null}}});return saved;});return{data:updated};}
 @Roles(Role.ADMIN,Role.TEACHER) @Get('predictions') async predictions(@CurrentUser() actor:AuthUser,@Query('termId') termId?:string,@Query('page') p?:string,@Query('pageSize') s?:string){const pg=pageQuery(p,s);const where={...(termId?{termId}:{}),...(actor.role==='TEACHER'?{student:{is:{enrollments:{some:{status:'ENROLLED' as const,offering:{teacher:{userId:actor.id}}}}}}}:{})};const [data,total]=await this.prisma.$transaction([this.prisma.prediction.findMany({where,include:{student:{select:{id:true,studentNumber:true,name:true}},term:{select:{code:true,label:true}},modelVersion:{select:{version:true,targetDefinition:true,metrics:true}},reviews:{orderBy:{createdAt:'desc'},include:{reviewer:{select:{name:true,role:true}}}}},orderBy:{generatedAt:'desc'},skip:pg.skip,take:pg.pageSize}),this.prisma.prediction.count({where})]);return{data,meta:{page:pg.page,pageSize:pg.pageSize,total,totalPages:Math.ceil(total/pg.pageSize)}};}
 /**
  * Student-facing / staff prediction generation stays disabled until university approvals
  * and a non-synthetic validated model exist. Synthetic ML outputs are never persisted here.
  */
 @Roles(Role.ADMIN,Role.TEACHER) @Post('predictions/generate') async generate(){
  const policyApproved = process.env.ML_UNIVERSITY_POLICY_APPROVED === 'true';
  const persistenceEnabled = process.env.ML_PREDICTION_PERSISTENCE_ENABLED === 'true';
  const probe = await this.ml.probe();
  const reasons = [
    'University approvals are required for dataset provenance, prediction target, horizon, risk thresholds, feature availability, human review policy, intended use, and consent.',
    'No rules-based substitute is used.',
    'Synthetic demo ML outputs must never be stored or shown as actual student risk assessments.',
  ];
  if (!policyApproved) reasons.push('ML_UNIVERSITY_POLICY_APPROVED is false.');
  if (!persistenceEnabled) reasons.push('ML_PREDICTION_PERSISTENCE_ENABLED is false.');
  if (!probe.reachable) reasons.push(`ML service unreachable: ${probe.error ?? 'unavailable'}`);
  else if (probe.ready?.isSynthetic || probe.ready?.operatingMode === 'synthetic_demo') reasons.push('Loaded ML artifact/runtime is synthetic_demo only.');
  else if (!probe.ready?.modelAvailable) reasons.push('ML service reports model_required.');
  throw new ServiceUnavailableException({
    code: 'PREDICTION_GENERATION_DISABLED',
    message: 'No approved trained model and risk policy are configured. Training is required; no rules-based substitute is used.',
    reasons,
    mlService: probe.reachable
      ? { reachable: true, status: probe.ready?.status, operatingMode: probe.ready?.operatingMode, isSynthetic: probe.ready?.isSynthetic, modelAvailable: probe.ready?.modelAvailable, modelVersion: probe.ready?.modelVersion }
      : { reachable: false, error: probe.error },
  });
 }
 /** Admin-only connectivity probe. Does not generate or persist predictions. */
 @Roles(Role.ADMIN) @Get('ml/status') async mlStatus(){
  return { data: await this.demoPredictions.status() };
 }
 /**
  * Demo-only synthetic inference + persistence. Explicitly labeled DEMO / SYNTHETIC.
  * Production POST /predictions/generate remains gated and disabled.
  */
 @Roles(Role.ADMIN) @Post('predictions/demo/generate') async generateDemo(@Body() dto: DemoGenerateDto, @CurrentUser() actor: AuthUser){
  return { data: await this.demoPredictions.generateDemoPredictions(actor.id, dto.termId) };
 }
 @Roles(Role.ADMIN, Role.TEACHER) @Get('predictions/demo/summary') async demoSummary(@Query('termId') termId?: string){
  return { data: await this.demoPredictions.demoSummary(termId) };
 }
 @Roles(Role.ADMIN,Role.TEACHER) @Post('predictions/:id/reviews') async review(@Param('id') id:string,@Body() dto:ReviewDto,@CurrentUser() actor:AuthUser){const pred=await this.prisma.prediction.findUnique({where:{id},select:{id:true,studentId:true}});if(!pred)throw new NotFoundException('Prediction not found');if(actor.role==='TEACHER'){const allowed=await this.prisma.courseOffering.count({where:{teacher:{userId:actor.id},enrollments:{some:{studentId:pred.studentId,status:'ENROLLED'}}}});if(!allowed)throw new ForbiddenException('Prediction is outside assigned courses');}return{data:await this.prisma.$transaction(async tx=>{const review=await tx.predictionReview.create({data:{predictionId:id,reviewerId:actor.id,outcome:dto.outcome,rationale:dto.rationale}});await tx.auditLog.create({data:{actorId:actor.id,action:'PREDICTION_REVIEW',entityType:'Prediction',entityId:id,changes:{outcome:dto.outcome}}});return review;})};}
 @Get('notifications') async notifications(@CurrentUser() actor:AuthUser,@Query('unread') unread?:string,@Query('page') p?:string,@Query('pageSize') s?:string){const pg=pageQuery(p,s);const where={recipientId:actor.id,inAppVisible:true,...(unread==='true'?{readAt:null}:{})};const [data,total]=await this.prisma.$transaction([this.prisma.notification.findMany({where,skip:pg.skip,take:pg.pageSize,orderBy:{createdAt:'desc'}}),this.prisma.notification.count({where})]);return{data,meta:{page:pg.page,pageSize:pg.pageSize,total,totalPages:Math.ceil(total/pg.pageSize)}};}
 @Roles(Role.ADMIN) @Get('notifications/email/controls') async emailControls(){
  const providerConfig=this.notificationEmail.providerConfiguration();
  const allowlist=this.testEmailAllowlist();
  return{data:{
    emailPolicyApproved:providerConfig.emailPolicyApproved,
    smtpEnabled:providerConfig.smtpEnabled,
    emailProvider:providerConfig.provider,
    providerConfigured:providerConfig.configured,
    fromAddressConfigured:providerConfig.fromAddressConfigured,
    canSend:providerConfig.canSend,
    workerEnabled:this.configFlag('EMAIL_WORKER_ENABLED',true),
    workerAutoRetry:this.configFlag('EMAIL_WORKER_AUTO_RETRY'),
    automatedRiskAlertEmailEnabled:false,
    testEmailEnabled:allowlist.length>0&&providerConfig.canSend,
    testRecipientCount:allowlist.length,
    testRecipientsMasked:allowlist.map((email)=>this.maskEmail(email)),
    disclaimer:'SMTP_ACCEPTED means provider acceptance only (SMTP, Brevo, or Resend). Automated ML risk-alert email remains disabled. Test emails only reach EMAIL_TEST_RECIPIENTS allowlist.',
  }};
 }
 /** Admin configuration probe. Verifies provider settings without sending email. */
 @Roles(Role.ADMIN) @Get('notifications/email/provider') async emailProviderStatus(){
  return{data:this.notificationEmail.providerConfiguration()};
 }
 /**
  * Admin-triggered test email to an explicitly allowlisted recipient only.
  * Never emails students from synthetic risk predictions.
  */
 @Roles(Role.ADMIN) @Post('notifications/email/test') async sendTestEmail(@Body() dto: TestEmailDto, @CurrentUser() actor: AuthUser, @Headers('idempotency-key') key?: string){
  if(!this.configFlag('EMAIL_POLICY_APPROVED')||!this.configFlag('SMTP_ENABLED')){
   throw new ServiceUnavailableException({code:'EMAIL_DISABLED',message:'EMAIL_POLICY_APPROVED and SMTP_ENABLED must both be true to send test email.'});
  }
  const allowlist=this.testEmailAllowlist();
  const to=dto.to.trim().toLowerCase();
  if(!allowlist.includes(to)){
   throw new ForbiddenException({code:'TEST_RECIPIENT_NOT_ALLOWED',message:'Recipient is not in EMAIL_TEST_RECIPIENTS allowlist.'});
  }
  if(!key||!/^[A-Za-z0-9._:-]{8,120}$/.test(key))throw new BadRequestException('Provide an Idempotency-Key between 8 and 120 safe characters');
  const recipient=await this.prisma.user.findFirst({where:{email:{equals:to,mode:'insensitive'},status:'ACTIVE'},select:{id:true,email:true,preference:{select:{email:true}}}});
  if(!recipient)throw new NotFoundException('No active user account matches the allowlisted test recipient email');
  if(!recipient.preference?.email){
   await this.prisma.notificationPreference.upsert({
    where:{userId:recipient.id},
    create:{userId:recipient.id,inApp:true,email:true,weeklySummary:false,categories:{}},
    update:{email:true},
   });
  }
  const subject=(dto.subject??'Academic Sentinel test email').trim();
  const message=(dto.message??'This is a controlled Academic Sentinel test email to a verified allowlisted recipient. It is not a student risk alert.').trim();
  const existing=await this.prisma.notification.findUnique({where:{idempotencyKey:key},include:{emailDelivery:{select:{id:true,status:true,attemptCount:true,providerMessageId:true,lastErrorCode:true,acceptedAt:true}}}});
  if(existing)return{data:{notification:existing,emailDelivery:existing.emailDelivery,duplicate:true,disclaimer:'Test email only; not a student risk alert.'}};
  const notification=await this.prisma.$transaction(async tx=>{
   const created=await tx.notification.create({
    data:{
     recipientId:recipient.id,
     title:subject.slice(0,180),
     message:message.slice(0,1000),
     idempotencyKey:key,
     inAppVisible:true,
     emailDelivery:{create:{status:'PENDING'}},
    },
    include:{emailDelivery:{select:{id:true,status:true,attemptCount:true,providerMessageId:true,lastErrorCode:true,acceptedAt:true}}},
   });
   await tx.auditLog.create({data:{actorId:actor.id,action:'EMAIL_TEST_SEND',entityType:'Notification',entityId:created.id,changes:{recipientMasked:this.maskEmail(to),idempotencyKey:key}}});
   return created;
  });
  const emailDelivery=await this.notificationEmail.dispatch(notification.id);
  return{data:{notification,emailDelivery,duplicate:false,disclaimer:'Test email only; not a student risk alert. SMTP_ACCEPTED means provider acceptance only.'}};
 }
 @Roles(Role.ADMIN) @Get('notifications/email-deliveries') async emailDeliveries(@Query('page') p?:string,@Query('pageSize') s?:string,@Query('status') status?:string){
  const pg=pageQuery(p,s);
  const allowed=['PENDING','SENDING','SMTP_ACCEPTED','FAILED','SUPPRESSED_PREFERENCE','SKIPPED_DISABLED'] as const;
  const statusFilter=status&&(allowed as readonly string[]).includes(status)?{status:status as typeof allowed[number]}:{};
  const where={notification:{is:{alertId:null}},...statusFilter};
  const [data,total]=await this.prisma.$transaction([
    this.prisma.notificationEmailDelivery.findMany({where,skip:pg.skip,take:pg.pageSize,orderBy:{createdAt:'desc'},select:{id:true,status:true,attemptCount:true,providerMessageId:true,lastErrorCode:true,acceptedAt:true,createdAt:true,updatedAt:true,notification:{select:{id:true,title:true,recipient:{select:{name:true,email:true}}}}}}),
    this.prisma.notificationEmailDelivery.count({where}),
  ]);
  return{data,meta:{page:pg.page,pageSize:pg.pageSize,total,totalPages:Math.ceil(total/pg.pageSize)},disclaimer:'SMTP_ACCEPTED means provider acceptance only; inbox delivery is not confirmed.'};
 }
 @Roles(Role.ADMIN) @Get('notifications/:id/email/logs') async emailDeliveryLogs(@Param('id') id:string,@Query('page') p?:string,@Query('pageSize') s?:string){
  const notification=await this.prisma.notification.findUnique({where:{id},select:{id:true,alertId:true}});
  if(!notification||notification.alertId)throw new NotFoundException('Manual notification email log not found');
  const pg=pageQuery(p,s);
  const where={entityType:'NotificationEmailDelivery',entityId:id};
  const [data,total]=await this.prisma.$transaction([
    this.prisma.auditLog.findMany({where,skip:pg.skip,take:pg.pageSize,orderBy:{createdAt:'desc'},select:{id:true,action:true,changes:true,createdAt:true}}),
    this.prisma.auditLog.count({where}),
  ]);
  return{data,meta:{page:pg.page,pageSize:pg.pageSize,total,totalPages:Math.ceil(total/pg.pageSize)}};
 }
 @Roles(Role.ADMIN) @Post('notifications') async createNotification(@Body() dto:CreateNotificationDto,@Headers('idempotency-key') key?:string,@CurrentUser() actor?:AuthUser){
  if(!key||!/^[A-Za-z0-9._:-]{8,120}$/.test(key))throw new BadRequestException('Provide an Idempotency-Key between 8 and 120 safe characters');
  const existing=await this.prisma.notification.findUnique({where:{idempotencyKey:key},include:{emailDelivery:{select:{id:true,status:true,attemptCount:true,providerMessageId:true,lastErrorCode:true,acceptedAt:true}}}});
  if(existing)return{data:{notification:existing,emailDelivery:existing.emailDelivery,duplicate:true}};
  if(!dto.title.trim()||!dto.message.trim())throw new BadRequestException('Title and message cannot be blank');
  let notification;
  try{notification=await this.prisma.$transaction(async tx=>{
   const recipient=await tx.user.findUnique({where:{id:dto.recipientId},select:{id:true,status:true,preference:{select:{inApp:true,email:true}}}});
   if(!recipient||recipient.status!=='ACTIVE')throw new NotFoundException('Active notification recipient not found');
   const created=await tx.notification.create({data:{recipientId:dto.recipientId,title:dto.title.trim(),message:dto.message.trim(),idempotencyKey:key,inAppVisible:recipient.preference?.inApp??true,emailDelivery:{create:{status:'PENDING'}}},include:{emailDelivery:{select:{id:true,status:true,attemptCount:true,providerMessageId:true,lastErrorCode:true,acceptedAt:true}}}});
   await tx.auditLog.create({data:{actorId:actor?.id??null,action:'NOTIFICATION_CREATED',entityType:'Notification',entityId:created.id,changes:{recipientId:dto.recipientId,idempotencyKey:key,emailQueued:true}}});
   return created;
  });}catch(error){if(typeof error==='object'&&error!==null&&'code'in error&&(error as {code:unknown}).code==='P2002'){const duplicate=await this.prisma.notification.findUnique({where:{idempotencyKey:key},include:{emailDelivery:{select:{id:true,status:true,attemptCount:true,providerMessageId:true,lastErrorCode:true,acceptedAt:true}}}});if(duplicate)return{data:{notification:duplicate,emailDelivery:duplicate.emailDelivery,duplicate:true}};}throw error;}
  // Emit only after the create transaction committed. Idempotent duplicates above do not emit.
  if(notification.inAppVisible){
   this.notificationGateway.emitNotificationNew(notification.recipientId,{
    id:notification.id,
    type:notification.alertId?'alert_linked':'manual',
    title:notification.title,
    message:notification.message,
    createdAt:notification.createdAt instanceof Date?notification.createdAt.toISOString():String(notification.createdAt),
    readAt:notification.readAt instanceof Date?notification.readAt.toISOString():notification.readAt??null,
   });
  }
  const emailDelivery=await this.notificationEmail.dispatch(notification.id);
  return{data:{notification,emailDelivery,duplicate:false}};
 }
 @Roles(Role.ADMIN) @Post('notifications/:id/email/retry') async retryNotificationEmail(@Param('id') id:string){return{data:await this.notificationEmail.retry(id)};}
 private testEmailAllowlist():string[]{
  return (process.env.EMAIL_TEST_RECIPIENTS||'')
   .split(',')
   .map((part)=>part.trim().toLowerCase())
   .filter((email)=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
 }
 private maskEmail(email:string):string{
  const [local,domain]=email.split('@');
  if(!domain)return '***';
  const visible=local.slice(0,2);
  return `${visible}${'*'.repeat(Math.max(1,local.length-2))}@${domain}`;
 }
 private configFlag(name:string,fallback=false){const raw=process.env[name];if(raw===undefined||raw==='')return fallback;return raw==='true'||raw==='1';}
 @Patch('notifications/:id/read') async markRead(@Param('id') id:string,@CurrentUser() actor:AuthUser){const result=await this.prisma.notification.updateMany({where:{id,recipientId:actor.id,inAppVisible:true},data:{readAt:new Date()}});if(!result.count)throw new NotFoundException('Notification not found');return{data:{read:true}};}
 @Post('notifications/read-all') async markAllRead(@CurrentUser() actor:AuthUser){const result=await this.prisma.notification.updateMany({where:{recipientId:actor.id,readAt:null},data:{readAt:new Date()}});return{data:{updated:result.count}};}
 @Roles(Role.ADMIN,Role.TEACHER) @Get('analytics/summary') async analytics(@CurrentUser() actor:AuthUser,@Query('termId') termId?:string){const scoped=actor.role==='TEACHER'?{enrollments:{some:{status:'ENROLLED' as const,offering:{teacher:{userId:actor.id}}}}}:{};const alertScope=actor.role==='TEACHER'?{student:{is:scoped}}:{};const [students,alerts,predictions]=await Promise.all([this.prisma.student.count({where:{status:'ACTIVE',...scoped}}),this.prisma.riskAlert.groupBy({by:['severity','status'],where:{...(termId?{termId}:{}),...alertScope},_count:true}),this.prisma.prediction.count({where:{...(termId?{termId}:{}),...(actor.role==='TEACHER'?{student:{is:scoped}}:{})}})]);return{data:{studentCount:students,predictionCount:predictions,alertsBySeverityAndStatus:alerts}};}
 @Get('users/me') async profile(@CurrentUser() actor:AuthUser){return{data:await this.prisma.user.findUnique({where:{id:actor.id},select:{id:true,email:true,name:true,role:true,status:true,createdAt:true,preference:true}})};}
 @Patch('users/me') async updateProfile(@CurrentUser() actor:AuthUser,@Body() dto:ProfileDto){return{data:await this.prisma.user.update({where:{id:actor.id},data:dto,select:{id:true,email:true,name:true,role:true,status:true,updatedAt:true}})};}
 @Patch('users/me/preferences') async updatePreferences(@CurrentUser() actor:AuthUser,@Body() dto:PreferencesDto){const existing=await this.prisma.notificationPreference.findUnique({where:{userId:actor.id}});const categories={highRiskAlerts:dto.highRiskAlerts??Boolean((existing?.categories as Record<string,unknown>|undefined)?.highRiskAlerts??true),attendanceAlerts:dto.attendanceAlerts??Boolean((existing?.categories as Record<string,unknown>|undefined)?.attendanceAlerts??true)};return{data:await this.prisma.notificationPreference.upsert({where:{userId:actor.id},create:{userId:actor.id,inApp:dto.inApp??true,email:dto.email??false,weeklySummary:dto.weeklySummary??false,categories},update:{...(dto.inApp!==undefined?{inApp:dto.inApp}:{}),...(dto.email!==undefined?{email:dto.email}:{}),...(dto.weeklySummary!==undefined?{weeklySummary:dto.weeklySummary}:{}),categories}})};}
}
