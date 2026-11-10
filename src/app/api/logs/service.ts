import { JsonProtocol } from "../protocols"
import { defineService, type RequestContext } from "../registry"
import { logGroupArn, logStreamArn } from "../db/logs"
import {
  createLogGroup, createLogStream, deleteLogGroup, deleteLogStream, deleteRetentionPolicy, describeLogGroups, describeLogStreams,
  filterLogEvents, getLogEvents, listTagsForResource, putLogEvents, putRetentionPolicy, tagResource, untagResource,
} from "./operations"

// The resources an operation touches, for the policy engine: the log group, or the log stream in it.
const scopeOf = (ctx: RequestContext) => ({ account: ctx.account, region: ctx.region })
const groupResource = (ctx: RequestContext) => [logGroupArn(scopeOf(ctx), String(ctx.params.logGroupName))]
const streamResource = (ctx: RequestContext) => [logStreamArn(scopeOf(ctx), String(ctx.params.logGroupName), String(ctx.params.logStreamName))]
const anyGroup = (ctx: RequestContext) => [logGroupArn(scopeOf(ctx), '*')]

export const logs = defineService({
  iamPrefix: 'logs',
  protocol: new JsonProtocol('1.1'),
  operations: {
    CreateLogGroup: { handler: createLogGroup, resources: groupResource },
    DeleteLogGroup: { handler: deleteLogGroup, resources: groupResource },
    DescribeLogGroups: { handler: describeLogGroups, resources: anyGroup },
    CreateLogStream: { handler: createLogStream, resources: streamResource },
    DeleteLogStream: { handler: deleteLogStream, resources: streamResource },
    DescribeLogStreams: { handler: describeLogStreams, resources: groupResource },
    PutLogEvents: { handler: putLogEvents, resources: streamResource },
    GetLogEvents: { handler: getLogEvents, resources: streamResource },
    FilterLogEvents: { handler: filterLogEvents, resources: groupResource },
    PutRetentionPolicy: { handler: putRetentionPolicy, resources: groupResource },
    DeleteRetentionPolicy: { handler: deleteRetentionPolicy, resources: groupResource },
    ListTagsForResource: { handler: listTagsForResource, resources: ctx => [String(ctx.params.resourceArn)] },
    TagResource: { handler: tagResource, resources: ctx => [String(ctx.params.resourceArn)] },
    UntagResource: { handler: untagResource, resources: ctx => [String(ctx.params.resourceArn)] },
  },
})
