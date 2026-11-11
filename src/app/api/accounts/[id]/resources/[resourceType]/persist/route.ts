import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { NextRequest, NextResponse } from 'next/server';

const dbPath = join(process.cwd(), 'db');

// Helper to find the resource file path
async function findResourceFilePath(accountId: string, resourceType: string): Promise<string> {
  const type = resourceType.toLowerCase();
  
  // Try global resource first
  const globalPath = join(dbPath, accountId, `${type}.json`);
  try {
    await readFile(globalPath);
    return globalPath;
  } catch {
    // Not found, try regions
  }

  // Try common regions
  const regions = ['eu-central-1', 'eu-west-1', 'us-east-1', 'us-west-2'];
  for (const region of regions) {
    const regionPath = join(dbPath, accountId, region, `${type}.json`);
    try {
      await readFile(regionPath);
      return regionPath;
    } catch {
      // Continue to next region
    }
  }

  // Default to eu-central-1 if creating new
  return join(dbPath, accountId, 'eu-central-1', `${type}.json`);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; resourceType: string }> }
) {
  try {
    const { id: accountId, resourceType } = await params;
    const { key, data } = await request.json();

    if (!key || !data) {
      return NextResponse.json(
        { error: 'Missing key or data' },
        { status: 400 }
      );
    }

    const filePath = await findResourceFilePath(accountId, resourceType);

    // Read existing data
    let resources: any;
    try {
      const content = await readFile(filePath, 'utf-8');
      resources = JSON.parse(content);
    } catch {
      resources = {};
    }

    // Update the resource
    if (!resources[key]) {
      resources[key] = {};
    }
    resources[key] = { ...resources[key], ...data };

    // Write back to file
    await writeFile(filePath, JSON.stringify(resources, null, 2));

    return NextResponse.json({ success: true, data: resources[key] });
  } catch (error) {
    console.error('Error updating resource:', error);
    return NextResponse.json(
      { error: 'Failed to update resource' },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; resourceType: string }> }
) {
  try {
    const { id: accountId, resourceType } = await params;
    const { key, data } = await request.json();

    if (!key || !data) {
      return NextResponse.json(
        { error: 'Missing key or data' },
        { status: 400 }
      );
    }

    const filePath = await findResourceFilePath(accountId, resourceType);

    // Read existing data
    let resources: any;
    try {
      const content = await readFile(filePath, 'utf-8');
      resources = JSON.parse(content);
    } catch {
      resources = {};
    }

    // Check if resource already exists
    if (resources[key]) {
      return NextResponse.json(
        { error: 'Resource already exists' },
        { status: 409 }
      );
    }

    // Add the new resource
    resources[key] = data;

    // Write back to file
    await writeFile(filePath, JSON.stringify(resources, null, 2));

    return NextResponse.json({ success: true, data: resources[key] });
  } catch (error) {
    console.error('Error creating resource:', error);
    return NextResponse.json(
      { error: 'Failed to create resource' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; resourceType: string }> }
) {
  try {
    const { id: accountId, resourceType } = await params;
    const { key } = await request.json();

    if (!key) {
      return NextResponse.json(
        { error: 'Missing key' },
        { status: 400 }
      );
    }

    const filePath = await findResourceFilePath(accountId, resourceType);

    // Read existing data
    let resources: any;
    try {
      const content = await readFile(filePath, 'utf-8');
      resources = JSON.parse(content);
    } catch {
      return NextResponse.json(
        { error: 'Resource file not found' },
        { status: 404 }
      );
    }

    // Delete the resource
    if (!resources[key]) {
      return NextResponse.json(
        { error: 'Resource not found' },
        { status: 404 }
      );
    }

    delete resources[key];

    // Write back to file
    await writeFile(filePath, JSON.stringify(resources, null, 2));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting resource:', error);
    return NextResponse.json(
      { error: 'Failed to delete resource' },
      { status: 500 }
    );
  }
}
