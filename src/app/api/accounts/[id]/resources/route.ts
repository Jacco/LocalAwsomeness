import { readdir } from 'fs/promises';
import { join } from 'path';
import { NextRequest, NextResponse } from 'next/server';

const dataPath = join(process.cwd(), 'db');

interface ResourceCount {
  [key: string]: number;
}

async function countResources(accountId: string): Promise<any[]> {
  try {
    const accountDir = join(dataPath, accountId);
    const resources: Map<string, { type: string; region: string | null; count: number }> = new Map();

    try {
      const dirs = await readdir(accountDir, { withFileTypes: true });

      for (const dir of dirs) {
        // Check for global resources (files at account root level like iam.json)
        if (dir.isFile() && dir.name.endsWith('.json') && dir.name !== 'account.json' && dir.name !== 'credentials.json') {
          const resourceType = dir.name
            .replace('.json', '')
            .toUpperCase();

          const key = `${resourceType}-global`;
          resources.set(key, {
            type: resourceType,
            region: null, // Global resource
            count: (resources.get(key)?.count || 0) + 1,
          });
        }
        // Check region directories
        else if (dir.isDirectory()) {
          const regionPath = join(accountDir, dir.name);
          const regionName = dir.name;

          try {
            const entries = await readdir(regionPath, { withFileTypes: true });

            for (const entry of entries) {
              // Check if it's a file (resource data)
              if (entry.isFile() && entry.name.endsWith('.json')) {
                // Extract resource type from filename (e.g., "ssm.json" -> "SSM")
                const resourceType = entry.name
                  .replace('.json', '')
                  .toUpperCase();

                const key = `${resourceType}-${regionName}`;
                resources.set(key, {
                  type: resourceType,
                  region: regionName,
                  count: (resources.get(key)?.count || 0) + 1,
                });
              }
              // Also check if it's a directory containing resource files (legacy structure)
              else if (entry.isDirectory()) {
                const typePath = join(regionPath, entry.name);
                try {
                  const files = await readdir(typePath);
                  const count = files.filter((f) => f.endsWith('.json')).length;

                  if (count > 0) {
                    const resourceType = entry.name.toUpperCase();
                    const key = `${resourceType}-${regionName}`;
                    resources.set(key, {
                      type: resourceType,
                      region: regionName,
                      count: (resources.get(key)?.count || 0) + count,
                    });
                  }
                } catch {
                  // Skip if can't read
                }
              }
            }
          } catch {
            // Skip if region directory can't be read
          }
        }
      }
    } catch {
      // Account directory doesn't exist yet
    }

    // Add S3 resources if available
    try {
      const s3Path = join(dataPath, 's3');
      const s3Entries = await readdir(s3Path, { withFileTypes: true });
      const s3Files = s3Entries.filter(e => e.isFile() && e.name.endsWith('.json'));
      if (s3Files.length > 0) {
        resources.set('s3-global', {
          type: 'S3',
          region: null,
          count: s3Files.length,
        });
      }
    } catch {
      // S3 path doesn't exist
    }

    // Add CloudTrail resources if available
    try {
      const ctPath = join(dataPath, 'cloudtrail');
      const ctFiles = await readdir(ctPath);
      const ctEventsFile = ctFiles.find(f => f === `${accountId}-events.jsonl`);
      if (ctEventsFile) {
        resources.set('cloudtrail-global', {
          type: 'CloudTrail',
          region: null,
          count: 1,
        });
      }
    } catch {
      // CloudTrail path doesn't exist
    }

    return Array.from(resources.values());
  } catch (error) {
    console.error('Error counting resources:', error);
    return [];
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const resources = await countResources(id);
    return NextResponse.json(resources);
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to read resources' },
      { status: 500 }
    );
  }
}
