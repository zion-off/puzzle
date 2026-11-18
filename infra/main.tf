# The puzzle Worker, its Durable Object, static assets and R2 bucket. Deployed by
# .github/workflows/deploy.yml on every push to main. wrangler.jsonc only
# configures local dev and the build; this file is what runs in production.

terraform {
  required_version = ">= 1.10"

  # The deploy workflow passes bucket, key and region during terraform init.
  backend "s3" {}

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.29"
    }
  }
}

# The deploy workflow sets CLOUDFLARE_API_TOKEN and TF_VAR_cloudflare_account_id.
provider "cloudflare" {}

variable "cloudflare_account_id" {
  type = string
}

# Ed25519 private JWK that signs every piece. Never change it after launch, or
# every piece already taken stops verifying.
variable "signing_key" {
  type      = string
  sensitive = true
}

variable "admin_token" {
  type      = string
  sensitive = true
}

locals {
  worker = "${path.module}/../dist/puzzle/index.js"
}

# Pieces sitting in the puzzle.
resource "cloudflare_r2_bucket" "puzzle" {
  account_id = var.cloudflare_account_id
  name       = "puzzle"
}

resource "cloudflare_workers_script" "puzzle" {
  account_id         = var.cloudflare_account_id
  script_name        = "puzzle"
  main_module        = "index.js"
  content_file       = local.worker
  content_sha256     = filesha256(local.worker)
  compatibility_date = "2025-09-01"

  assets = {
    directory = "${path.module}/../dist/client"
    config = {
      not_found_handling = "single-page-application"
      run_worker_first   = ["/api/*"]
    }
  }

  bindings = [
    { name = "PUZZLE", type = "durable_object_namespace", class_name = "Puzzle" },
    { name = "BUCKET", type = "r2_bucket", bucket_name = cloudflare_r2_bucket.puzzle.name },
    { name = "SIGNING_KEY", type = "secret_text", text = var.signing_key },
    { name = "ADMIN_TOKEN", type = "secret_text", text = var.admin_token },
  ]

  migrations = {
    new_tag            = "v1"
    new_sqlite_classes = ["Puzzle"]
  }

  observability = {
    enabled = true
  }
}
