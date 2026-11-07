// s3-service 动态导入此模块，使 AWS SDK 只在实际使用 S3 时才求值
export { S3Client, PutObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
