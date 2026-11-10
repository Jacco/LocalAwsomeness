# EC2 networking verification (phases 1-3) against the local dev server.
#
#   cd scripts/verify-ec2 && terraform init && terraform apply -auto-approve
#   terraform plan -detailed-exitcode        # must exit 0: no changes after apply
#   terraform destroy -auto-approve
#
# Credentials come from the default AWS profile (the bootstrap key of db/tokens.json). Run it from a scratch
# copy if you do not want .terraform and the state file in the working tree.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region                  = "eu-west-1"
  skip_metadata_api_check = true

  # sts:GetCallerIdentity gives the provider its account ID; without it, references to security groups are
  # read back as "<account>/<group id>" and show up as a diff.
  endpoints {
    ec2 = "http://localhost:3000"
    sts = "http://localhost:3000"
  }
}

# --- network (phases 1 and 2) ---------------------------------------------------------------------------------

resource "aws_vpc" "main" {
  cidr_block           = "10.60.0.0/16"
  enable_dns_hostnames = true
  tags                 = { Name = "verify" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "verify" }
}

resource "aws_subnet" "public" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.60.1.0/24"
  availability_zone = "eu-west-1a"
  tags              = { Name = "verify-public" }
}

resource "aws_subnet" "private" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.60.2.0/24"
  availability_zone = "eu-west-1b"
  tags              = { Name = "verify-private" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "verify-public" }

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "verify-private" }
}

resource "aws_route" "extra" {
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "10.99.0.0/16"
  gateway_id             = aws_internet_gateway.main.id
}

# --- Elastic IP and NAT gateway (phase 4, partial) --------------------------------------------------------------

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "verify-nat" }
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public.id
  tags          = { Name = "verify" }
  depends_on    = [aws_internet_gateway.main]
}

resource "aws_route" "private_default" {
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main.id
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  subnet_id      = aws_subnet.private.id
  route_table_id = aws_route_table.private.id
}

# --- security groups (phase 3) --------------------------------------------------------------------------------

# inline rules
resource "aws_security_group" "web" {
  name        = "verify-web"
  description = "web tier"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "verify-web" }

  ingress {
    description      = "https"
    from_port        = 443
    to_port          = 443
    protocol         = "tcp"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  ingress {
    description = "ping"
    from_port   = -1
    to_port     = -1
    protocol    = "icmp"
    cidr_blocks = ["10.60.0.0/16"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# references another group, and has no egress rule: the provider revokes the default one
resource "aws_security_group" "db" {
  name        = "verify-db"
  description = "database tier"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.web.id]
  }
}

# managed with the separate rule resources (DescribeSecurityGroupRules, ModifySecurityGroupRules)
resource "aws_security_group" "app" {
  name        = "verify-app"
  description = "app tier"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "ssh" {
  security_group_id = aws_security_group.app.id
  description       = "ssh"
  cidr_ipv4         = "10.60.0.0/16"
  from_port         = 22
  to_port           = 22
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "from_web" {
  security_group_id            = aws_security_group.app.id
  referenced_security_group_id = aws_security_group.web.id
  ip_protocol                  = "-1"
}

resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.app.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# the older single-rule resource
resource "aws_security_group" "legacy" {
  name        = "verify-legacy"
  description = "legacy rules"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group_rule" "legacy_in" {
  type              = "ingress"
  security_group_id = aws_security_group.legacy.id
  from_port         = 8080
  to_port           = 8081
  protocol          = "tcp"
  cidr_blocks       = ["10.60.0.0/16"]
}

resource "aws_security_group_rule" "legacy_out" {
  type              = "egress"
  security_group_id = aws_security_group.legacy.id
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
}

# --- network ACLs (phase 3) -----------------------------------------------------------------------------------

# inline rules, and the subnet association is made by the ACL
resource "aws_network_acl" "private" {
  vpc_id     = aws_vpc.main.id
  subnet_ids = [aws_subnet.private.id]
  tags       = { Name = "verify-private" }

  ingress {
    rule_no    = 100
    action     = "allow"
    protocol   = "tcp"
    from_port  = 443
    to_port    = 443
    cidr_block = "10.60.0.0/16"
  }

  egress {
    rule_no    = 100
    action     = "allow"
    protocol   = "-1"
    from_port  = 0
    to_port    = 0
    cidr_block = "0.0.0.0/0"
  }
}

# separate rule and association resources
resource "aws_network_acl" "public" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "verify-public" }
}

resource "aws_network_acl_rule" "http_in" {
  network_acl_id = aws_network_acl.public.id
  rule_number    = 200
  egress         = false
  protocol       = "tcp"
  rule_action    = "allow"
  cidr_block     = "0.0.0.0/0"
  from_port      = 80
  to_port        = 80
}

resource "aws_network_acl_rule" "all_out" {
  network_acl_id = aws_network_acl.public.id
  rule_number    = 200
  egress         = true
  protocol       = "-1"
  rule_action    = "allow"
  cidr_block     = "0.0.0.0/0"
}

resource "aws_network_acl_rule" "ping_in" {
  network_acl_id = aws_network_acl.public.id
  rule_number    = 210
  egress         = false
  protocol       = "icmp"
  rule_action    = "deny"
  cidr_block     = "192.0.2.0/24"
  icmp_type      = 8
  icmp_code      = -1
}

resource "aws_network_acl_association" "public" {
  network_acl_id = aws_network_acl.public.id
  subnet_id      = aws_subnet.public.id
}
