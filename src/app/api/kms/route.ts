import { NextRequest, NextResponse } from 'next/server'
import { handleKmsOperation, KmsRequest, KmsAction } from '../kms/kms'

/**
 * POST /api/kms
 * Handle KMS operations (CreateKey, DescribeKey, etc.)
 *
 * Request format:
 * {
 *   "action": "CreateKey",
 *   "description": "My encryption key",
 *   "policy": { ... }
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    
    // Extract account from header or default
    const account = request.headers.get('x-account-id') || '123456789012'
    const region = request.headers.get('x-region') || 'us-east-1'

    const kmsRequest: KmsRequest = {
      action: body.action as KmsAction,
      account,
      keyId: body.keyId,
      description: body.description,
      policy: body.policy,
      pendingWindowInDays: body.pendingWindowInDays
    }

    const response = handleKmsOperation(kmsRequest)

    return NextResponse.json(response.body, { status: response.status })
  } catch (error) {
    return NextResponse.json(
      {
        __type: 'InternalFailure',
        message: (error as any)?.message || 'Internal server error'
      },
      { status: 500 }
    )
  }
}

/**
 * GET /api/kms?action=DescribeKey&keyId=...
 * Handle KMS query operations
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const action = searchParams.get('action')
    const keyId = searchParams.get('keyId')
    const account = request.headers.get('x-account-id') || '123456789012'

    if (!action) {
      return NextResponse.json(
        { error: 'action parameter required' },
        { status: 400 }
      )
    }

    const kmsRequest: KmsRequest = {
      action: action as KmsAction,
      account,
      keyId: keyId || undefined
    }

    const response = handleKmsOperation(kmsRequest)

    return NextResponse.json(response.body, { status: response.status })
  } catch (error) {
    return NextResponse.json(
      {
        __type: 'InternalFailure',
        message: (error as any)?.message || 'Internal server error'
      },
      { status: 500 }
    )
  }
}
