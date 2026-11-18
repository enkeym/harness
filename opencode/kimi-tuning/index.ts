import { Plugin } from "@opencode/plugin"
import { KIMI_PROVIDER_ID, kimiCaps, tuneKimiModel } from "./tuning.mjs"

export default Plugin.define({
  id: "kimi.tuning",
  async setup({ provider }) {
    const caps = kimiCaps(process.env)

    await provider.transform((editor) => {
      const record = editor.get(KIMI_PROVIDER_ID)
      if (!record) return
      for (const modelID of record.models.keys()) {
        editor.models.update(KIMI_PROVIDER_ID, modelID, (model) => {
          tuneKimiModel(model, caps)
        })
      }
    })

    return () => {}
  }
})
