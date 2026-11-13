import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const root = mkdtempSync(join(tmpdir(), 'jpk-cfn-kms-'))
process.env.JPK_DB_ROOT = root

/* eslint-disable @typescript-eslint/no-require-imports */
const { cloudFormation } = require('@/app/api/cloudformation/service')
const { readCloudTrailEvents, clearCloudTrailEvents } = require('@/app/api/cloudtrail/cloudtrail')
const { listKeys } = require('@/app/api/kms/storage')

const account = '111111111111'
// No role "admin" exists, so the caller is not restricted by identity-based policies.
const CALLER = `arn:aws:sts::${account}:assumed-role/admin/alice`
const TEMPLATE = { Resources: { P: { Type: 'AWS::SSM::Parameter', Properties: { Name: '/p', Type: 'String', Value: 'v' } } } }
const templatesDir = (stack: string) => join(root, 'data', 'accounts', account, 'cloudformation', 'stacks', stack, 'templates')

async function call(params: Record<string, string>, region = 'eu-west-1') {
  const response: Response = await cloudFormation.post(new Request('http://localhost/api/cloudformation/', {
    method: 'POST',
    body: new URLSearchParams({ Version: '2010-05-15', ...params }).toString(),
    headers: {
      'x-aws-principal': CALLER,
      'x-aws-userid': 'AROAEXAMPLE:alice',
      authorization: `AWS4-HMAC-SHA256 Credential=KEY/20250101/${region}/cloudformation/aws4_request, SignedHeaders=host, Signature=abc`,
    },
  }))
  return { status: response.status, text: await response.text() }
}
const kmsEvents = () => readCloudTrailEvents(account).filter((e: any) => e.service === 'kms')
const stackId = (text: string) => text.match(/<StackId>([^<]+)<\/StackId>/)![1]

beforeAll(() => mkdirSync(join(root, account), { recursive: true }))
beforeEach(() => clearCloudTrailEvents(account))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('CloudFormation template storage with the AWS owned key', () => {
  it('generates a data key on CreateStack, keeps the template readable and stores the KMS record next to it', async () => {
    const created = await call({ Action: 'CreateStack', StackName: 's1', TemplateBody: JSON.stringify(TEMPLATE) })
    expect(created.status).toBe(200)
    const id = stackId(created.text)

    const [event] = kmsEvents()
    expect(kmsEvents()).toHaveLength(1)
    expect(event).toMatchObject({
      action: 'GenerateDataKey', principal: CALLER, account, region: 'eu-west-1', authorizationDecision: 'allow', simulated: true,
      resource: expect.stringMatching(/^arn:aws:kms:eu-west-1:000000000000:key\/[0-9a-f-]{36}$/),
      parameters: expect.objectContaining({
        keyManager: 'AWS_OWNED', invokedBy: 'cloudformation.amazonaws.com', keySpec: 'AES_256',
        encryptionContext: { 'aws:cloudformation:stack-id': id, templateVersion: '1' },
      }),
    })

    expect(JSON.parse(readFileSync(join(templatesDir('s1'), 'v1.json'), 'utf8'))).toEqual(TEMPLATE)
    const stored = JSON.parse(readFileSync(join(templatesDir('s1'), 'v1.kms.json'), 'utf8'))
    expect(stored).toMatchObject({ kmsKeyId: event.resource, keyManager: 'AWS_OWNED', encryptionContext: event.parameters.encryptionContext })
    expect(JSON.stringify(stored)).not.toContain('material')
  })

  it('decrypts the data key on GetTemplate', async () => {
    await call({ Action: 'CreateStack', StackName: 's2', TemplateBody: JSON.stringify(TEMPLATE) })
    clearCloudTrailEvents(account)
    const response = await call({ Action: 'GetTemplate', StackName: 's2' })
    expect(response.status).toBe(200)
    expect(response.text).toContain('AWS::SSM::Parameter')
    expect(kmsEvents()).toEqual([expect.objectContaining({ action: 'Decrypt', principal: CALLER, simulated: true })])
    expect(kmsEvents()[0].errorCode).toBeUndefined()
  })

  it('fails GetTemplate when the KMS record was tampered with', async () => {
    await call({ Action: 'CreateStack', StackName: 's3', TemplateBody: JSON.stringify(TEMPLATE) })
    const file = join(templatesDir('s3'), 'v1.kms.json')
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    const blob = Buffer.from(stored.encryptedDataKey, 'base64')
    blob[blob.length - 1] ^= 1
    writeFileSync(file, JSON.stringify({ ...stored, encryptedDataKey: blob.toString('base64') }))
    clearCloudTrailEvents(account)

    const response = await call({ Action: 'GetTemplate', StackName: 's3' })
    expect(response.status).toBe(400)
    expect(response.text).toContain('InvalidCiphertextException')
    expect(kmsEvents()).toEqual([expect.objectContaining({ action: 'Decrypt', errorCode: 'InvalidCiphertextException' })])
  })

  it('reports a lost AWS owned key on read, and recreates it for new data', async () => {
    await call({ Action: 'CreateStack', StackName: 'lost', TemplateBody: JSON.stringify(TEMPLATE) }, 'ap-south-1')
    unlinkSync(join(root, 'aws', 'kms', 'ap-south-1', 'cloudformation.json'))
    clearCloudTrailEvents(account)

    const read = await call({ Action: 'GetTemplate', StackName: 'lost' }, 'ap-south-1')
    expect(read.status).toBe(400)
    expect(read.text).toContain('<Code>NotFoundException</Code>')
    expect(read.text).toMatch(/AWS owned key arn:aws:kms:ap-south-1:000000000000:key\/\S+ of cloudformation that encrypted this data was lost/)
    expect(kmsEvents()).toEqual([expect.objectContaining({ action: 'Decrypt', errorCode: 'NotFoundException' })])

    expect((await call({ Action: 'CreateStack', StackName: 'after-loss', TemplateBody: JSON.stringify(TEMPLATE) }, 'ap-south-1')).status).toBe(200)
    expect((await call({ Action: 'GetTemplate', StackName: 'after-loss' }, 'ap-south-1')).status).toBe(200)
  })

  it('decrypts with the key the record names, whatever the Region of the request', async () => {
    await call({ Action: 'CreateStack', StackName: 'cross', TemplateBody: JSON.stringify(TEMPLATE) }, 'us-west-2')
    clearCloudTrailEvents(account)
    expect((await call({ Action: 'GetTemplate', StackName: 'cross' }, 'eu-west-1')).status).toBe(200)
    expect(kmsEvents()[0].resource).toMatch(/^arn:aws:kms:us-west-2:/)
  })

  it('uses one AWS owned key per Region, never visible in the account', async () => {
    await call({ Action: 'CreateStack', StackName: 's4', TemplateBody: JSON.stringify(TEMPLATE) })
    await call({ Action: 'CreateStack', StackName: 's5', TemplateBody: JSON.stringify(TEMPLATE) }, 'eu-central-1')
    await call({ Action: 'CreateStack', StackName: 's6', TemplateBody: JSON.stringify(TEMPLATE) })
    const [west, central, westAgain] = kmsEvents().map((e: any) => e.resource)
    expect(west).toBe(westAgain)
    expect(central).toMatch(/^arn:aws:kms:eu-central-1:000000000000:key\//)
    expect(central.split('/').at(-1)).not.toBe(west.split('/').at(-1))
    expect(listKeys(account)).toEqual([])
  })
})
