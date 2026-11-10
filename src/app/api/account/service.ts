import { PARTITION } from "../db/common"
import {
  deleteAlternateContact, enableRegion, disableRegion, getAlternateContact, getContactInformation,
  getRegion, listRegions, putAccountName, putAlternateContact, putContactInformation
} from "../db/account"
import { getAccount } from "../db/organizations"
import { RestJsonProtocol } from "../protocols"
import { defineService, type Handler, type Operation, type RequestContext } from "../registry"

// Every operation targets AccountId, defaulting to the caller's own account.
const target = ({ account, params }: RequestContext) => params.AccountId || account

function operation(handler: (accountId: string, ctx: RequestContext) => unknown): Operation {
  const run: Handler = ctx => handler(target(ctx), ctx)
  return { handler: run, resources: ctx => [`arn:${PARTITION}:account::${target(ctx)}:account`] }
}

export const account = defineService({
  iamPrefix: 'account',
  protocol: new RestJsonProtocol(),
  operations: {
    GetAccountInformation: operation(id => {
      const info = getAccount(id)
      return { AccountCreatedDate: info.requestedTimestamp, AccountId: info.id, AccountName: info.name }
    }),
    GetPrimaryEmail: operation(id => ({ PrimaryEmail: getAccount(id).email })),
    PutAccountName: operation((id, { params }) => putAccountName(id, params.AccountName)),

    GetContactInformation: operation(id => ({ ContactInformation: getContactInformation(id) })),
    PutContactInformation: operation((id, { params }) => putContactInformation(id, params.ContactInformation)),

    GetAlternateContact: operation((id, { params }) => ({ ContactInformation: getAlternateContact(id, params.AlternateContactType) })),
    PutAlternateContact: operation((id, { params }) => {
      const { AlternateContactType, EmailAddress, Name, PhoneNumber, Title } = params
      putAlternateContact(id, AlternateContactType, { EmailAddress, Name, PhoneNumber, Title })
    }),
    DeleteAlternateContact: operation((id, { params }) => deleteAlternateContact(id, params.AlternateContactType)),

    ListRegions: operation(id => ({
      Regions: Object.entries(listRegions(id)).map(([RegionName, RegionOptStatus]) => ({ RegionName, RegionOptStatus }))
    })),
    GetRegionOptStatus: operation((id, { params }) => ({
      RegionName: params.RegionName,
      RegionOptStatus: getRegion(id, params.RegionName)
    })),
    EnableRegion: operation((id, { params }) => enableRegion(id, params.RegionName)),
    DisableRegion: operation((id, { params }) => disableRegion(id, params.RegionName))
  }
})
