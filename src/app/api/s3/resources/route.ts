import { readFile } from 'fs/promises';
import { join } from 'path';
import { NextResponse } from 'next/server';

const dataPath = join(process.cwd(), 'db');

export async function GET() {
  try {
    const s3DataPath = join(dataPath, 's3', 'example-state-with-objects.json');
    const data = await readFile(s3DataPath, 'utf-8');
    const s3State = JSON.parse(data);
    
    // Transform to list of buckets with object counts
    const buckets = Object.entries(s3State.s3 || {}).map(([name, bucket]: any) => ({
      BucketName: bucket.BucketName || name,
      Region: bucket.Region,
      CreationDate: bucket.CreationDate,
      ObjectCount: Object.keys(bucket.Objects || {}).length,
      Arn: bucket.Arn,
    }));
    
    return NextResponse.json(buckets);
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to read S3 data' },
      { status: 500 }
    );
  }
}
