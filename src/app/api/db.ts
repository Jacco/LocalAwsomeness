import { existsSync, readFileSync, writeFileSync } from "fs";

enum JoinMethod { 
    CREATED = "CREATED",
    INVITED = "INVITED"
}

class Account {
    constructor(
        public id: string, 
        public name: string, 
        public email: string,
        public joinMethod: JoinMethod,
        public joinedTimestamp: number,
        public requestId: string,
        public requestedTimestamp: number,
        public completedTimestamp: number,
        public organizationId: string
    ) {
    }
}

class Organization {
    constructor(
        public id: string,
        public featureSet: string
    ) {
    }
}

function makeid(length: number, characters: string='0123456789') {
    var result           = '';
    var charactersLength = characters.length;
    for (var i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
}

export function getAccount(id: string): Account {
    let accounts: Account[] = []
    if (existsSync('db/accounts.json')) {
        accounts = JSON.parse(readFileSync('accounts.json').toString())
    }
    let faccounts = accounts.filter(x => x.id == id)
    if (faccounts.length == 0) {
        throw Error("Account not found")
    }
    return faccounts[0]
}

export function createAccount(name: string, email: string): Account {
    let accounts: Account[] = []
    let requestedTimestamp = Date.now()
    if (existsSync('db/accounts.json')) {
        accounts = JSON.parse(readFileSync('accounts.json').toString())
    }
    const ids = accounts.map(x => x.id)
    let id = makeid(12)
    while (true) {
        if (!ids.includes(id)) {
            break;
        }
        id = makeid(12)
    }
    if (accounts.filter(x => x.email == email).length > 0) {
        throw Error("Duplicate email")
    }
    const account = new Account(
        id, 
        name, 
        email, 
        JoinMethod.CREATED,
        Date.now(),
        crypto.randomUUID(),
        requestedTimestamp,
        Date.now()
    )
    accounts.push(account)
    writeFileSync('db/accounts.json', JSON.stringify(accounts, null, 2))
    return account
}

export function getCreateAccountStatus(id: string): Account {
    let accounts: Account[] = []
    if (existsSync('db/accounts.json')) {
        accounts = JSON.parse(readFileSync('db/accounts.json').toString())
    }
    let faccounts = accounts.filter(x => x.requestId == id)
    if (faccounts.length == 0) {
        throw Error("Request not found")
    }
    return faccounts[0]
}

export function createOrganization(features: string): Organization {
    let organization: Organization
    if (existsSync('db/organization.json')) {
        throw Error("Organization already exists")
    } else {
        const id  = 'o-' + makeid(10, 'abcdefghijklmnopqrstuvwxyz0123456789')
        organization = new Organization(id, features)
        writeFileSync('db/organization.json', JSON.stringify(organization, null, 2))
    }
    return organization
}

export function getOrganization(): Organization {
    let organization: Organization
    if (!existsSync('db/organization.json')) {
        throw Error("No organization exists")
    }
    organization = JSON.parse(readFileSync('db/organization.json').toString())
    return organization
}