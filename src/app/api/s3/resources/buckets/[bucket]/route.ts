import { readFile } from 'fs/promises';
import { join } from 'path';
import { NextRequest, NextResponse } from 'next/server';

const dataPath = join(process.cwd(), 'db');

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ bucket: string }> }
) {
  try {
    const { bucket } = await params;
    const s3DataPath = join(dataPath, 's3', 'example-state-with-objects.json');
    const data = await readFile(s3DataPath, 'utf-8');
    const s3State = JSON.parse(data);
    
    const bucketData = s3State.s3?.[bucket];
    if (!bucketData) {
      return NextResponse.json({ error: 'Bucket not found' }, { status: 404 });
    }
    
    // Transform objects
    const objects = Object.entries(bucketData.Objects || {}).map(([key, obj]: any) => ({
      Key: obj.Key || key,
      Size: obj.Size,
      LastModified: obj.LastModified,
      ContentType: obj.ContentType,
      ETag: obj.ETag,
      Body: obj.Body,
      Arn: obj.Arn,
    }));
    
    return NextResponse.json({
      BucketName: bucketData.BucketName || bucket,
      Region: bucketData.Region,
      CreationDate: bucketData.CreationDate,
      Objects: objects,
      BucketPolicy: bucketData.BucketPolicy,
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to read bucket data' },
      { status: 500 }
    );
  }
}
