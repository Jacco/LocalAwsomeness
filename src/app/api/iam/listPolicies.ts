import { Builder } from 'xml2js'
import * as iam from '../db/iam'

export function listPolicies(account: string) {
  // TODO MaxItems / Marker support
  // parse request info
  const policies = Object.entries(iam.listPolicies(account)).map(x => ({
    Arn: 'arn:aws:iam:::policy/' + x[0],
    PolicyName: x[0],
    PolicyId: x[1].PolicyId,
    IsAttachable: true,
    DefaultVersionId: x[1].DefaultVersion,
    Path: "/",
    // CreateDate
    // UpdateDate
  }))
  let obj = { 
    ListPoliciesResponse: {
      $: {
        "xmlns": "https://iam.amazonaws.com/doc/2010-05-08/"
      },
      ListPoliciesResult: {
        // IsTruncated
        // Marker
        Policies: {
          member: policies
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

// <ListPoliciesResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/">
//   <ListPoliciesResult>
//     <IsTruncated>true</IsTruncated>
//     <Marker>EXAMPLEkakv9BCuUNFDtxWSyfzetYwEx2ADc8dnzfvERF5S6YMvXKx41t6gCl/eeaCX3Jo94/bKqezEAg8TEVS
//     99EKFLxm3jtbpl25FDWEXAMPLE
//     </Marker>
//     <Policies>
//       <member>
//         <Arn>arn:aws:iam::123456789012:policy/ExamplePolicy</Arn>
//         <AttachmentCount>2</AttachmentCount>
//         <CreateDate>2014-09-15T17:36:14Z</CreateDate>
//         <DefaultVersionId>v1</DefaultVersionId>
//         <IsAttachable>true</IsAttachable>
//         <Path>/</Path>
//         <PermissionsBoundaryUsageCount>0</PermissionsBoundaryUsageCount>
//         <PolicyId>AGPACKCEVSQ6C2EXAMPLE</PolicyId>
//         <PolicyName>ExamplePolicy</PolicyName>
//         <UpdateDate>2014-09-15T20:31:47Z</UpdateDate>