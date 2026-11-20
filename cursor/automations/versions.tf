terraform {
  required_version = ">= 1.5.0"

  required_providers {
    cursor = {
      source  = "cursor/cursor"
      version = "~> 0.8"
    }
  }
}

provider "cursor" {
  token = var.cursor_token
}