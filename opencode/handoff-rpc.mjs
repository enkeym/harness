export default {
  id: "harness.handoff",
  methods: {},
  events: {
    changed: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          status: { enum: ["preparing", "ready", "error"] },
          message: { type: "string" },
          targetID: { type: "string" }
        },
        required: ["sessionID", "status", "message"],
        additionalProperties: false
      }
    }
  }
}
