import { AwsError } from "../common"
import { getRegion } from '../data/account'
import { PARTITION } from '../data/common'
import { defineService, type Handler, type Operation, type RequestContext } from "../registry"
import type { ResourcePolicy } from "../../auth/policy/authorizer"
import { S3Protocol } from "./protocol"
import { s3Storage } from "./storage"
import type { Op, Req } from "./s3"
import {
  createBucketOp, deleteBucketOp, listBucketsOp, headBucketOp,
  putBucketPolicyOp, getBucketPolicyOp, deleteBucketPolicyOp,
  putObjectOp, getObjectOp, deleteObjectOp, listObjectsV2Op, headObjectOp,
} from "./s3"

const bucketArn = ({ params }: RequestContext) => [`arn:${PARTITION}:s3:::${params.Bucket}`]
const objectArn = ({ params }: RequestContext) => [`arn:${PARTITION}:s3:::${params.Bucket}/${params.Key}`]

// Bucket names are global: a request is for the bucket of whichever account owns it, which may be another account than
// the caller's. Undefined when there is no bucket in the request or it does not exist.
function bucketOwner({ params }: RequestContext): string | undefined {
  return typeof params.Bucket === 'string' ? s3Storage.findBucketOwner(params.Bucket) : undefined
}

// The bucket policy decides together with the identity-based policies of the caller (src/app/api/policy/authorizer.ts).
function bucketPolicy(ctx: RequestContext): ResourcePolicy | undefined {
  const owner = bucketOwner(ctx)
  if (owner === undefined) {
    return undefined
  }
  const bucket = ctx.params.Bucket as string
  const document = s3Storage.getBucketPolicy(owner, bucket) ?? undefined
  return { account: owner, source: `bucket policy of ${bucket}`, document: document as ResourcePolicy['document'] }
}

// Handler wrapper for S3 operations: they work on the storage of the account that owns the bucket.
function s3Operation(op: Op): Handler {
  return ctx => {
    const scope = { account: ctx.account, region: ctx.region }
    if (getRegion(scope.account, scope.region) === 'DISABLED') {
      throw new AwsError('AuthFailure', 'AWS was not able to validate the provided access credentials', 401)
    }

    const owner = bucketOwner(ctx)
    const expected = ctx.params.ExpectedBucketOwner
    if (owner !== undefined && expected !== undefined && expected !== owner) {
      throw new AwsError('AccessDenied', 'Access Denied', 403)
    }

    const req: Req = {
      account: owner ?? ctx.account,
      callerAccount: ctx.account,
      region: ctx.region,
      principal: ctx.principal,
      params: ctx.params,
    }
    
    return op(req)
  }
}

interface Declaration {
  resources?: Operation['resources']
  action?: string
  // Whether the bucket policy takes part: not for ListBuckets (no bucket) and CreateBucket (the name of a bucket that
  // exists is taken, whoever may use that bucket).
  bucketPolicy?: boolean
}

function on(op: Op, { resources, action, bucketPolicy: withPolicy = true }: Declaration): Operation {
  return { handler: s3Operation(op), resources, action, resourcePolicy: withPolicy ? bucketPolicy : undefined }
}

export const s3 = defineService({
  iamPrefix: 's3',
  protocol: new S3Protocol(),
  operations: {
    // Bucket operations
    ListBuckets: on(listBucketsOp, { action: 's3:ListAllMyBuckets', bucketPolicy: false }),
    CreateBucket: on(createBucketOp, { resources: bucketArn, bucketPolicy: false }),
    DeleteBucket: on(deleteBucketOp, { resources: bucketArn }),
    HeadBucket: on(headBucketOp, { resources: bucketArn, action: 's3:ListBucket' }),

    // Bucket policy operations
    GetBucketPolicy: on(getBucketPolicyOp, { resources: bucketArn }),
    PutBucketPolicy: on(putBucketPolicyOp, { resources: bucketArn }),
    DeleteBucketPolicy: on(deleteBucketPolicyOp, { resources: bucketArn }),

    // Object operations
    GetObject: on(getObjectOp, { resources: objectArn }),
    PutObject: on(putObjectOp, { resources: objectArn }),
    DeleteObject: on(deleteObjectOp, { resources: objectArn }),
    HeadObject: on(headObjectOp, { resources: objectArn, action: 's3:GetObject' }),
    ListObjectsV2: on(listObjectsV2Op, { resources: bucketArn, action: 's3:ListBucket' }),
  },
})
