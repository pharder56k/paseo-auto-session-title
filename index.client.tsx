import { useEffect, useRef, useState } from "react";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  TextInput,
  useToast,
} from "@getpaseo/plugin/client/ui";
import {
  namingSettings,
  scanRpc,
  type NamingSettingsValues,
} from "./shared/settings";

function NamingSettingsScreen() {
  const settings = useSettings(namingSettings);
  const toast = useToast();
  const scan = useRpc(scanRpc);
  const scanStarted = useRef(false);
  const [draft, setDraft] = useState<NamingSettingsValues | null>(null);

  useEffect(() => {
    if (settings.status === "ready") setDraft((current) => current ?? { ...settings.values });
  }, [settings.status, draft]);

  useEffect(() => {
    if (scanStarted.current) return;
    scanStarted.current = true;
    void scan({});
  }, [scan]);

  if (settings.status !== "ready" || !draft) {
    const info =
      settings.status === "error" || settings.status === "invalid"
        ? settings.error
        : settings.status === "loading"
          ? "读取中…"
          : "设置不可用";
    return (
      <SettingsSection title="自动会话标题" info={info}>
        <SettingsAction label="设置" actionLabel="重新读取" onPress={() => void settings.reload()} />
      </SettingsSection>
    );
  }

  const patch = (next: Partial<NamingSettingsValues>): void => {
    setDraft({ ...draft, ...next });
  };

  const save = async (): Promise<void> => {
    const idleSeconds = Math.max(5, Math.min(3600, Math.round(Number(draft.idleSeconds) || 45)));
    const ok = await settings.save({ ...draft, idleSeconds }, settings.revision);
    toast.show(ok ? "设置已保存" : "保存失败，请重试", { variant: ok ? "success" : "error" });
  };

  return (
    <>
      <SettingsSection
        title="触发时机"
        info="会话连续空闲达到设定秒数后，自动读取完整对话并重新提炼标题。修改已有会话的话题后也会再次更新。"
      >
        <SettingsInput
          label="空闲等待时间（秒）"
          hint="范围 5–3600 秒，默认 45 秒"
          initialValue={String(draft.idleSeconds)}
          onChangeText={(text) => patch({ idleSeconds: Number(text) || 45 })}
          placeholder="45"
        />
      </SettingsSection>

      <SettingsSection title="侧栏显示" info="手机/桌面端侧栏显示的是 workspace 名称；开启后会同步改成新标题，改的只是 workspace 的显示标题。">
        <SettingsSwitch
          label="同步重命名工作区标题"
          hint="关闭则只修改会话（agent）标题，侧栏仍显示原工作区名称"
          value={draft.syncWorkspaceTitle}
          onValueChange={(syncWorkspaceTitle) => patch({ syncWorkspaceTitle })}
        />
      </SettingsSection>

      <SettingsSection title="命名模型" info="用于提炼标题的小模型；失败时保留原名，不影响会话本身。">
        <SettingsSelect
          label="模型来源"
          hint="跟随会话主模型：使用当前会话正在使用的主模型（可能更慢、更贵）"
          value={draft.modelMode}
          options={[
            { label: "pi 默认模型（推荐）", value: "default" },
            { label: "跟随本轮会话主模型", value: "follow-agent" },
            { label: "固定模型", value: "fixed" },
          ]}
          onValueChange={(modelMode) => patch({ modelMode })}
        />
        {draft.modelMode === "fixed" ? (
          <SettingsInput
            label="固定模型 ID"
            hint="例如 deepseek/deepseek-flash 或 magpie/opencode-go/hy4-flash-free"
            initialValue={draft.fixedModel}
            onChangeText={(text) => patch({ fixedModel: text })}
            placeholder="deepseek/deepseek-flash"
          />
        ) : null}
      </SettingsSection>

      <SettingsSection
        title="命名提示词"
        info="已预填当前默认规则（日期｜类型｜主题）。可整段改写为你自己的命名风格；{MMDD} 会替换为会话创建日期。"
      >
        <TextInput
          multiline
          numberOfLines={12}
          value={draft.customPrompt}
          onChangeText={(text) => patch({ customPrompt: text })}
          placeholder="输入自定义提示词"
          style={{
            minHeight: 220,
            padding: 12,
            borderWidth: 1,
            borderRadius: 8,
            textAlignVertical: "top",
          }}
        />
      </SettingsSection>

      <SettingsSection
        title="已有会话"
        info="扫描当前主机上尚未锁定的历史会话并安排改名；用户手改过的会话会自动跳过。"
      >
        <SettingsAction
          label="历史会话批量改名"
          actionLabel="立即扫描"
          onPress={() => void scan({}).then((result) => {
            toast.show(`已扫描 ${result.scanned} 个会话，安排 ${result.scheduled} 个`);
          })}
        />
      </SettingsSection>

      <SettingsSection title="保存">
        <SettingsAction label="应用设置" actionLabel="保存" onPress={() => void save()} disabled={settings.saving} />
        <SettingsAction
          label="恢复默认"
          hint="把所有选项恢复为插件默认值"
          actionLabel="重置"
          onPress={() => void settings.reset()}
          disabled={settings.saving}
        />
        {settings.saveError ? <SettingsAction label="错误" actionLabel={settings.saveError} onPress={() => undefined} /> : null}
      </SettingsSection>
    </>
  );
}

export default function contribute(client: PluginClientContext) {
  const remove = client.addSettingsScreen({
    id: "naming",
    title: "自动命名",
    icon: "Sparkles",
    Component: NamingSettingsScreen,
  });
  return remove;
}
