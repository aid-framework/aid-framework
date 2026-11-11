variable "project" {
  type = object({
    name      = string
    namespace = string
  })
}

variable "project_id" {
  description = "The project the alert policies are created in."
  type        = string
}

variable "alert_channel_ids" {
  description = "Ids of the notification channels the policies notify. Empty creates the policies without a destination."
  type        = list(string)
  default     = []
}

variable "tags" {
  type    = map(string)
  default = {}
}
