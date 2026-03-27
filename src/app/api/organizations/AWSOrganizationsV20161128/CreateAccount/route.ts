// AccessDeniedException
// AWSOrganizationsNotInUseException
// InvalidInputException
// AccountName Length Constraints: Minimum length of 1. Maximum length of 50. Pattern: [\u0020-\u007E]+
// Email (no duplicate!)
// The rules for a valid email address:
// The address must be a minimum of 6 and a maximum of 64 characters long.
// All characters must be 7-bit ASCII characters.
// There must be one and only one @ symbol, which separates the local name from the domain name.
// The local name can't contain any of the following characters:
// whitespace, " ' ( ) < > [ ] : ; , \ | % &
// The local name can't begin with a dot (.)
// The domain name can consist of only the characters [a-z],[A-Z],[0-9], hyphen (-), or dot (.)
// The domain name can't begin or end with a hyphen (-) or dot (.)
// The domain name must contain at least one dot
// IamUserAccessToBilling ALLOW DENY
// RoleName Pattern: [\w+=,.@-]{1,64}

  //  "IamUserAccessToBilling": "string",
  //  "RoleName": "string",
  //  "Tags": [ 
  //     { 
  //        "Key": "string",
  //        "Value": "string"
  //     }
  //  ]

import { createAccount } from '../../../db'

export async function POST(request: Request) {
  const body = await request.json()
  const { AccountName, Email } = body
  // check parameters
  const nmtest = /^[\u0020-\u007E]+$/
  if (!nmtest.test(AccountName)) {
    return new Response(JSON.stringify({
      code: 'InvalidInputException',
      message: `The AccountName "${AccountName}" has character that are not allowed`
    }), { status: 400 })
  }
  try {
    const acct = createAccount(
      AccountName, 
      Email
    )
    return new Response(JSON.stringify({
          "CreateAccountStatus": { 
              "AccountId": acct.id,
              "AccountName": acct.name,
              "CompletedTimestamp": Date.now(),
              // "FailureReason": "string",
              // "GovCloudAccountId": "string",
              "Id": acct.requestId,
              "RequestedTimestamp": acct.requestedTimestamp,
              "State": "SUCCEEDED" // IN_PROGRESS | SUCCEEDED | FAILED
          }
      }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({
      code: 'InvalidInputException',
      message: (e as Error).message
    }), { status: 400 })
  }
}