import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const getS3FilePath = (accountId: string, region: string = 'eu-central-1'): string => {
  const dbPath = path.join(process.cwd(), 'db', accountId, region);
  if (!fs.existsSync(dbPath)) {
    fs.mkdirSync(dbPath, { recursive: true });
  }
  return path.join(dbPath, 's3.json');
};

const readS3Data = (accountId: string, region: string = 'eu-central-1'): any => {
  const filePath = getS3FilePath(accountId, region);
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  }
  return {};
};

const writeS3Data = (accountId: string, data: any, region: string = 'eu-central-1'): void => {
  const filePath = getS3FilePath(accountId, region);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
};

export async function POST(
  req: NextRequest,
  context: any
) {
  try {
    const params = await context.params;
    const accountId = Array.isArray(params.id) ? params.id[0] : params.id;
    const region = req.nextUrl.searchParams.get('region') || 'eu-central-1';

    const body = await req.json();
    const { key, data } = body;

    if (!key || !data) {
      return NextResponse.json(
        { error: 'Missing key or data' },
        { status: 400 }
      );
    }

    const s3Data = readS3Data(accountId, region);
    s3Data[key] = data;
    writeS3Data(accountId, s3Data, region);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('S3 persist error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to persist S3 data' },
      { status: 500 }
    );
  }
}

export async function PUT(
  req: NextRequest,
  context: any
) {
  try {
    const params = await context.params;
    const accountId = Array.isArray(params.id) ? params.id[0] : params.id;
    const region = req.nextUrl.searchParams.get('region') || 'eu-central-1';

    const body = await req.json();
    const { key, data } = body;

    if (!key || !data) {
      return NextResponse.json(
        { error: 'Missing key or data' },
        { status: 400 }
      );
    }

    const s3Data = readS3Data(accountId, region);
    s3Data[key] = data;
    writeS3Data(accountId, s3Data, region);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('S3 persist error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to persist S3 data' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  context: any
) {
  try {
    const params = await context.params;
    const accountId = Array.isArray(params.id) ? params.id[0] : params.id;
    const region = req.nextUrl.searchParams.get('region') || 'eu-central-1';

    const body = await req.json();
    const { key } = body;

    if (!key) {
      return NextResponse.json(
        { error: 'Missing key' },
        { status: 400 }
      );
    }

    const s3Data = readS3Data(accountId, region);
    delete s3Data[key];
    writeS3Data(accountId, s3Data, region);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('S3 persist error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to persist S3 data' },
      { status: 500 }
    );
  }
}
