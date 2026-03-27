import { getOrganization } from '../../../db/organizations'

export async function POST(request: Request) {
    const principal = request.headers.get('x-aws-principal')
    const account = principal?.split(':')[4]
    const acct = account
    const org = getOrganization()
    return new Response(JSON.stringify({
        "Organization": { 
            "Arn": `arn:aws:organizations::${acct}:organization/${org.id}`,
            "AvailablePolicyTypes": [ 
                { 
                    "Status": "string",
                    "Type": "string"
                }
            ],
            "FeatureSet": org.featureSet,
            "Id": org.id,
            "MasterAccountArn": "string",
            "MasterAccountEmail": "string",
            "MasterAccountId": "string"
        }
    }))
}