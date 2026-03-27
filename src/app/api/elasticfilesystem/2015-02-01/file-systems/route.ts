export async function GET(request: Request) {
  // For example, fetch data from your DB here
  const principal = request.headers.get('x-aws-principal')
  const account = principal?.split(':').at(4)!
  console.log(principal)
  const users = {
    "FileSystems": [
      {
        "OwnerId": account,
        "CreationToken": "MyFileSystem1",
        "FileSystemId": "fs-01234567",
        "PerformanceMode": "generalPurpose",
        "CreationTime": "1403301078",
        "LifeCycleState": "created",
        "Name": "my first file system",
        "NumberOfMountTargets": 1,
        "SizeInBytes": {
          "Timestamp": 1403301078,
          "Value": 29313618372,
          "ValueInArchive": 201156,
          "ValueInIA": 675432,
          "ValueInStandard": 29312741784
        }
      }
    ]
  }
  return new Response(JSON.stringify(users), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

// {
//    "AvailabilityZoneName": "string",
//    "Backup": boolean,
//    "CreationToken": "string",
//    "Encrypted": boolean,
//    "KmsKeyId": "string",
//    "PerformanceMode": "string",
//    "ProvisionedThroughputInMibps": number,
//    "Tags": [ 
//       { 
//          "Key": "string",
//          "Value": "string"
//       }
//    ],
//    "ThroughputMode": "string"
// }

export async function POST(request: Request) {
  console.log('create file system', request.url)
  return new Response(JSON.stringify({}), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}