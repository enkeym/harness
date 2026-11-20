import { Plugin } from "@opencode/plugin"
import { OPENCODE_GO_PROVIDER_ID, opencodeGoCaps, tuneOpencodeGoModel } from "./tuning.mjs"

export default Plugin.define({
  id: "opencode-go.tuning",
  async setup({ provider }) {
    const caps = opencodeGoCaps(process.env)

    await provider.transform((editor) => {
      const record = editor.get(OPENCODE_GO_PROVIDER_ID)
      if (!record) return
      for (const modelID of record.models.keys()) {
        editor.models.update(OPENCODE_GO_PROVIDER_ID, modelID, (model) => {
          tuneOpencodeGoModel(model, caps)
        })
      }
    })

    return () => {}
  }
})
