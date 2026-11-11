import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET(
  req: NextRequest,
  context: any
) {
  try {
    const params = await context.params;
    const accountId = Array.isArray(params.id) ? params.id[0] : params.id;
    const region = req.nextUrl.searchParams.get('region') || 'eu-central-1';

    const dbPath = path.join(process.cwd(), 'db', accountId, region);
    const filePath = path.join(dbPath, 's3.json');

    if (!fs.existsSync(filePath)) {
      return NextResponse.json({});
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content);

    return NextResponse.json(data);
  } catch (err) {
    console.error('S3 fetch error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to fetch S3 data' },
      { status: 500 }
    );
  }
}
