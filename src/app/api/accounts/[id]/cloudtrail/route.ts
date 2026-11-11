import { readFile } from 'fs/promises';
import { join } from 'path';
import { NextRequest, NextResponse } from 'next/server';

const dataPath = join(process.cwd(), 'db');

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const ctPath = join(dataPath, 'cloudtrail', `${id}-events.jsonl`);
    
    const data = await readFile(ctPath, 'utf-8');
    const events = data
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line));
    
    return NextResponse.json(events);
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to read CloudTrail events' },
      { status: 500 }
    );
  }
}
