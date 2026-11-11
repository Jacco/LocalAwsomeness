import { AwsError } from "../common"
import { getRegion } from "../db/account"
import { PARTITION } from "../db/common"
import { defineService, type Handler, type Operation, type RequestContext } from "../registry"
import { S3Protocol } from "./protocol"
import type { Op, Req } from "./s3"
import {
  createBucketOp, deleteBucketOp, listBucketsOp, headBucketOp,
  putBucketPolicyOp, getBucketPolicyOp, deleteBucketPolicyOp,
  putObjectOp, getObjectOp, deleteObjectOp, listObjectsV2Op, headObjectOp,
} from "./s3"

const bucketArn = ({ params }: RequestContext) => [`arn:${PARTITION}:s3:::${params.Bucket}`]
const objectArn = ({ params }: RequestContext) => [`arn:${PARTITION}:s3:::${params.Bucket}/${params.Key}`]

// Handler wrapper for S3 operations
function s3Operation(op: Op): Handler {
  return ctx => {
    const scope = { account: ctx.account, region: ctx.region }
    if (getRegion(scope.account, scope.region) === 'DISABLED') {
      throw new AwsError('AuthFailure', 'AWS was not able to validate the provided access credentials', 401)
    }
    
    const req: Req = {
      account: ctx.account,
      region: ctx.region,
      principal: ctx.principal,
      params: ctx.params,
    }
    
    return op(req)
  }
}

function on(op: Op, resources: Operation['resources'], action?: string): Operation {
  return { handler: s3Operation(op), resources, action }
}

export const s3 = defineService({
  iamPrefix: 's3',
  protocol: new S3Protocol(),
  operations: {
    // Bucket operations
    ListBuckets: on(listBucketsOp, undefined, 's3:ListAllMyBuckets'),
    CreateBucket: on(createBucketOp, bucketArn),
    DeleteBucket: on(deleteBucketOp, bucketArn),
    HeadBucket: on(headBucketOp, bucketArn, 's3:ListBucket'),

    // Bucket policy operations
    GetBucketPolicy: on(getBucketPolicyOp, bucketArn),
    PutBucketPolicy: on(putBucketPolicyOp, bucketArn),
    DeleteBucketPolicy: on(deleteBucketPolicyOp, bucketArn),

    // Object operations
    GetObject: on(getObjectOp, objectArn),
    PutObject: on(putObjectOp, objectArn),
    DeleteObject: on(deleteObjectOp, objectArn),
    HeadObject: on(headObjectOp, objectArn, 's3:GetObject'),
    ListObjectsV2: on(listObjectsV2Op, bucketArn, 's3:ListBucket'),
  },
})
