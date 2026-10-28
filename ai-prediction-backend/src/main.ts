import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { ApiExceptionFilter } from './common/filters/api-exception.filter';

async function bootstrap() {
 const app=await NestFactory.create(AppModule,{bufferLogs:true,bodyParser:false});
 app.use(express.json({limit:'6mb'})); app.use(express.urlencoded({extended:true,limit:'6mb'}));
 app.useLogger(app.get(Logger)); app.setGlobalPrefix('api/v1'); app.use(helmet()); app.use(cookieParser());
 const origins=(process.env.CORS_ORIGINS??'').split(',').map(v=>v.trim()).filter(Boolean);
 app.enableCors({origin:origins,credentials:true,methods:['GET','POST','PATCH','DELETE','OPTIONS'],allowedHeaders:['Content-Type','Authorization','X-Request-Id','Idempotency-Key','X-CSRF-Token']});
 app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true})); app.useGlobalFilters(new ApiExceptionFilter());
 const doc=new DocumentBuilder().setTitle('Academic Sentinel API').setDescription('Local academic performance and early warning API').setVersion('1.0').addCookieAuth('access_token').build();
 SwaggerModule.setup('api/docs',app,SwaggerModule.createDocument(app,doc));
 await app.listen(Number(process.env.PORT??4000),'0.0.0.0');
}
void bootstrap();
