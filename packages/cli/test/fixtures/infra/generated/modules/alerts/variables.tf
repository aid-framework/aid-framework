variable "project" {
  type = object({
    name      = string
    namespace = string
  })
}

variable "alert_channel_ids" {
  description = "ARNs of the CloudWatch actions the alarms notify. Empty creates the alarms without a destination."
  type        = list(string)
  default     = []
}

variable "tags" {
  type    = map(string)
  default = {}
}
