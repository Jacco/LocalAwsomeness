import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { NextRequest, NextResponse } from 'next/server';

const dbPath = join(process.cwd(), 'db', 'accounts.json');

async function readAccounts() {
  try {
    const content = await readFile(dbPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return [];
  }
}

async function writeAccounts(accounts: any[]) {
  await writeFile(dbPath, JSON.stringify(accounts, null, 2), 'utf-8');
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const accounts = await readAccounts();
    const account = accounts.find((acc: any) => acc.id === id);

    if (!account) {
      return NextResponse.json(
        { error: 'Account not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(account);
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to read account' },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const updates = await request.json();
    const accounts = await readAccounts();
    const index = accounts.findIndex((acc: any) => acc.id === id);

    if (index === -1) {
      return NextResponse.json(
        { error: 'Account not found' },
        { status: 404 }
      );
    }

    // Preserve immutable fields
    const updated = {
      ...accounts[index],
      ...updates,
      id: accounts[index].id,
      joinedTimestamp: accounts[index].joinedTimestamp,
    };

    accounts[index] = updated;
    await writeAccounts(accounts);

    return NextResponse.json(updated);
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to update account' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const accounts = await readAccounts();
    const filtered = accounts.filter((acc: any) => acc.id !== id);

    if (filtered.length === accounts.length) {
      return NextResponse.json(
        { error: 'Account not found' },
        { status: 404 }
      );
    }

    await writeAccounts(filtered);
    return NextResponse.json({ message: 'Account deleted' });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to delete account' },
      { status: 500 }
    );
  }
}
