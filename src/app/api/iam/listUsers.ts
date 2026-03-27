import { Builder, BuilderOptions } from 'xml2js'

export function listUsers(): Response {
  let obj = { 
    ListUsersResponse: {
      $: {
        "xmlns": "https://iam.amazonaws.com/doc/2010-05-08/"
      },
      ListUsersResult: {
        Users: {
          member: [
            { 
              UserName: "Andrew" 
              // <UserId>AID2MAB8DPLSRHEXAMPLE</UserId>
              // <Path>/division_abc/subdivision_xyz/engineering/</Path>
              // <Arn>arn:aws:iam::123456789012:user/division_abc/subdivision_xyz/engineering/Andrew</Arn>
              // <CreateDate>2012-09-05T19:38:48Z</CreateDate>
              // <PasswordLastUsed>2014-09-08T21:47:36Z</PasswordLastUsed>
            },
            { 
              UserName: "Jackie"
            }
          ]
        }
      }
    }
  };  
  var builder = new Builder({ headless: true });
  var xml = builder.buildObject(obj);
  return new Response(
    xml,
    {
      status: 201,
      headers: { 'Content-Type': 'application/xml' }
    }
  )
}

// <ListUsersResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/">
//   <ListUsersResult>
//     <Users>
//        <member>
//           <UserId>AID2MAB8DPLSRHEXAMPLE</UserId>
//           <Path>/division_abc/subdivision_xyz/engineering/</Path>
//           <UserName>Andrew</UserName>
//           <Arn>arn:aws:iam::123456789012:user/division_abc/subdivision_xyz/engineering/Andrew</Arn>
//           <CreateDate>2012-09-05T19:38:48Z</CreateDate>
//           <PasswordLastUsed>2014-09-08T21:47:36Z</PasswordLastUsed>
//        </member>
//        <member>
//           <UserId>AIDIODR4TAW7CSEXAMPLE</UserId>
//           <Path>/division_abc/subdivision_xyz/engineering/</Path>
//           <UserName>Jackie</UserName>
//           <Arn>arn:aws:iam::123456789012:user/division_abc/subdivision_xyz/engineering/Jackie</Arn>
//           <CreateDate>2014-04-09T15:43:45Z</CreateDate>
//           <PasswordLastUsed>2014-09-24T16:18:07Z</PasswordLastUsed>
//        </member>
//     </Users>
//     <IsTruncated>false</IsTruncated>
//   </ListUsersResult>
//   <ResponseMetadata>
//     <RequestId>7a62c49f-347e-4fc4-9331-6e8eEXAMPLE</RequestId>
//   </ResponseMetadata>
// </ListUsersResponse>