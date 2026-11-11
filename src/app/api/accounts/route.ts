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

export async function GET() {
  try {
    const accounts = await readAccounts();
    return NextResponse.json(accounts);
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to read accounts' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const newAccount = await request.json();
    const accounts = await readAccounts();

    // Check if account already exists
    if (accounts.some((acc: any) => acc.id === newAccount.id)) {
      return NextResponse.json(
        { error: 'Account with this ID already exists' },
        { status: 409 }
      );
    }

    accounts.push(newAccount);
    await writeAccounts(accounts);

    return NextResponse.json(newAccount, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to create account' },
      { status: 500 }
    );
  }
}
