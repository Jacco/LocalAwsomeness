# Lambda verification against the local dev server: a function in a VPC (shared interface), one without a VPC.
#
#   cp -r scripts/verify-lambda /tmp/tfverify-lambda && cd /tmp/tfverify-lambda
#   terraform init && terraform apply -auto-approve
#   terraform plan -detailed-exitcode        # must exit 0: no changes after apply
#   terraform destroy -auto-approve
#
# Credentials come from the default AWS profile (the bootstrap key of db/tokens.json).

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }
}

provider "aws" {
  region                  = "eu-west-1"
  skip_metadata_api_check = true

  endpoints {
    ec2    = "http://localhost:3000"
    sts    = "http://localhost:3000"
    iam    = "http://localhost:3000"
    lambda = "http://localhost:3000"
    cloudwatchlogs = "http://localhost:3000"
  }
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/verify/app"
  retention_in_days = 7
  tags              = { Name = "verify-lambda" }
}

resource "aws_vpc" "main" {
  cidr_block = "10.61.0.0/16"
  tags       = { Name = "verify-lambda" }
}

resource "aws_subnet" "private" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.61.2.0/24"
  tags       = { Name = "verify-lambda-private" }
}

resource "aws_security_group" "fn" {
  name        = "verify-lambda-fn"
  description = "the functions"
  vpc_id      = aws_vpc.main.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_iam_role" "fn" {
  name = "verify-lambda-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

data "archive_file" "code" {
  type        = "zip"
  output_path = "${path.module}/function.zip"
  source {
    filename = "index.py"
    content  = "def handler(event, context):\n    return {'hello': event}\n"
  }
}

# two functions with the same subnet and security group share one interface
resource "aws_lambda_function" "a" {
  function_name    = "verify-lambda-a"
  role             = aws_iam_role.fn.arn
  runtime          = "python3.12"
  handler          = "index.handler"
  filename         = data.archive_file.code.output_path
  source_code_hash = data.archive_file.code.output_base64sha256
  timeout          = 10
  memory_size      = 256
  description      = "in a VPC"
  environment {
    variables = { STAGE = "verify" }
  }
  vpc_config {
    subnet_ids         = [aws_subnet.private.id]
    security_group_ids = [aws_security_group.fn.id]
  }
  tags = { Name = "a" }
}

resource "aws_lambda_function" "b" {
  function_name    = "verify-lambda-b"
  role             = aws_iam_role.fn.arn
  runtime          = "python3.12"
  handler          = "index.handler"
  filename         = data.archive_file.code.output_path
  source_code_hash = data.archive_file.code.output_base64sha256
  vpc_config {
    subnet_ids         = [aws_subnet.private.id]
    security_group_ids = [aws_security_group.fn.id]
  }
}

resource "aws_lambda_function" "plain" {
  function_name    = "verify-lambda-plain"
  role             = aws_iam_role.fn.arn
  runtime          = "python3.12"
  handler          = "index.handler"
  filename         = data.archive_file.code.output_path
  source_code_hash = data.archive_file.code.output_base64sha256
}
