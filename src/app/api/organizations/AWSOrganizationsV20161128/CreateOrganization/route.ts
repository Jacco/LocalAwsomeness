import { createOrganization } from '../../../db'

export async function POST(request: Request) {
    const body = await request.json()
    const { FeatureSet } = body
    const org = createOrganization(FeatureSet)
    return new Response(JSON.stringify({
        "Organization": { 
            "Arn": "string",
            "AvailablePolicyTypes": [ 
                { 
                    "Status": "string",
                    "Type": "string"
                }
            ],
            "FeatureSet": "string",
            "Id": org.id,
            "MasterAccountArn": "string",
            "MasterAccountEmail": "string",
            "MasterAccountId": "string"
        }
    }))
}