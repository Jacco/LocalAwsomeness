import { readFile } from 'fs/promises';
import { join } from 'path';
import { NextRequest, NextResponse } from 'next/server';

const dbPath = join(process.cwd(), 'db');

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; resourceType: string }> }
) {
  try {
    const { id, resourceType } = await params;
    
    // First try global resource (at account root)
    const globalResourcePath = join(dbPath, id, `${resourceType}.json`);
    
    try {
      const content = await readFile(globalResourcePath, 'utf-8');
      const data = JSON.parse(content);
      return NextResponse.json(data);
    } catch {
      // Not a global resource, try region-based resources
    }

    // Try to fetch from eu-central-1
    const resourceFilePath = join(dbPath, id, 'eu-central-1', `${resourceType}.json`);

    try {
      const content = await readFile(resourceFilePath, 'utf-8');
      const data = JSON.parse(content);
      return NextResponse.json(data);
    } catch {
      // Try eu-west-1
      const resourceFilePath2 = join(dbPath, id, 'eu-west-1', `${resourceType}.json`);
      const content = await readFile(resourceFilePath2, 'utf-8');
      const data = JSON.parse(content);
      return NextResponse.json(data);
    }
  } catch (error) {
    return NextResponse.json(
      { error: 'Resource not found' },
      { status: 404 }
    );
  }
}
