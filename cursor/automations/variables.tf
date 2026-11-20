variable "cursor_token" {
  type        = string
  sensitive   = true
  description = "Cursor API token (key_ or crsr_ service account key). Defaults to env CURSOR_TOKEN."
  default     = null
}

variable "environment_public_id" {
  type        = string
  description = "S6_CUT Cloud Agent environment public id (used when syncing missing environment on workflows)."
  default     = "7a28f83d-e4a1-11f1-9535-02900022bdcd"
}