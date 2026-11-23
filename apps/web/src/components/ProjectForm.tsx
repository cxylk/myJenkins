import { useEffect, useRef, useState } from 'react';
import { App as AntdApp, Button, Card, Col, Divider, Drawer, Form, Input, InputNumber, Row, Select, Space, Switch, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { projectApi, type ProjectPayload } from '../api';
import type { Credential, Project, ServerInfo, User } from '../types';

interface Props {
  open: boolean;
  project?: Project | null;
  credentials: Credential[];
  servers: ServerInfo[];
  users: User[];
  onClose: () => void;
  onSaved: (project: Project) => void;
}

interface TargetFormValue {
  serverId?: number;
  remoteDir?: string;
  deployCommands?: string;
  enabled?: boolean;
}

interface ProjectFormValues {
  name: string;
  description?: string;
  repoUrl: string;
  credentialId?: number | null;
  defaultBranch: string;
  buildEnabled: boolean;
  buildCommand?: string;
  targetRuntime?: string | null;
  artifactPath: string;
  excludePatterns?: string[];
  buildTimeoutSec: number;
  deployTimeoutSec: number;
  onTargetFailure: 'abort' | 'continue';
  keepWorkspace: boolean;
  targets: TargetFormValue[];
  memberIds?: number[];
}

const DEFAULT_VALUES: ProjectFormValues = {
  name: '',
  description: '',
  repoUrl: '',
  credentialId: null,
  defaultBranch: '',
  buildEnabled: true,
  buildCommand: '',
  targetRuntime: null,
  artifactPath: '',
  excludePatterns: [],
  buildTimeoutSec: 900,
  deployTimeoutSec: 300,
  onTargetFailure: 'abort',
  keepWorkspace: false,
  targets: [{ remoteDir: '', deployCommands: '', enabled: true }],
  memberIds: [],
};

function pickDefaultBranch(branches: string[]): string | undefined {
  for (const name of ['develop_standard', 'main', 'master']) {
    if (branches.includes(name)) return name;
  }
  return branches.find((name) => name.startsWith('develop')) ?? branches[0];
}

const RUNTIME_OPTIONS = [
  { value: 'linux-x64', label: 'linux-x64 · Linux x64（Docker 常用）' },
  { value: 'linux-arm64', label: 'linux-arm64 · Linux ARM64' },
  { value: 'linux-musl-x64', label: 'linux-musl-x64 · Alpine / musl' },
  { value: 'win-x64', label: 'win-x64 · Windows x64' },
  { value: 'win-x86', label: 'win-x86 · Windows x86' },
  { value: 'win-arm64', label: 'win-arm64 · Windows ARM64' },
  { value: 'osx-x64', label: 'osx-x64 · macOS Intel' },
  { value: 'osx-arm64', label: 'osx-arm64 · macOS Apple Silicon' },
];

export function ProjectForm({ open, project, credentials, servers, users, onClose, onSaved }: Props) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<ProjectFormValues>();
  const [branchOptions, setBranchOptions] = useState<string[]>([]);
  const [branchLoading, setBranchLoading] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);
  const branchRequestId = useRef(0);
  const watchedRepoUrl = Form.useWatch('repoUrl', form) as string | undefined;
  const watchedCredentialId = Form.useWatch('credentialId', form) as number | null | undefined;

  const loadBranches = async (repoArg?: string, credentialArg?: number | null) => {
    const repoUrl = String(repoArg ?? form.getFieldValue('repoUrl') ?? '').trim();
    if (!repoUrl) return;
    const credentialId = credentialArg === undefined ? (form.getFieldValue('credentialId') ?? null) : credentialArg;
    const requestId = ++branchRequestId.current;
    setBranchLoading(true);
    setBranchError(null);
    try {
      const result = await projectApi.previewBranches(repoUrl, credentialId ?? null);
      if (requestId !== branchRequestId.current) return;
      setBranchOptions(result.branches);
      if (result.branches.length === 0) {
        setBranchError('远程仓库没有可用分支');
        return;
      }
      const current = form.getFieldValue('defaultBranch');
      if (!current) {
        const preferred = pickDefaultBranch(result.branches);
        if (preferred) form.setFieldValue('defaultBranch', preferred);
      } else if (!result.branches.includes(current)) {
        setBranchError(`默认分支「${current}」不在远程仓库中，请重新选择`);
      }
    } catch (error) {
      if (requestId !== branchRequestId.current) return;
      setBranchOptions([]);
      setBranchError(error instanceof Error ? error.message : '加载分支失败');
    } finally {
      if (requestId === branchRequestId.current) setBranchLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setBranchOptions([]);
    setBranchError(null);
    branchRequestId.current += 1;
  }, [open, project?.id]);

  useEffect(() => {
    if (!open) return;
    const repoUrl = String(watchedRepoUrl ?? '').trim();
    if (!repoUrl) {
      setBranchOptions([]);
      setBranchError(null);
      return;
    }
    const timer = setTimeout(() => {
      void loadBranches(repoUrl, watchedCredentialId ?? null);
    }, 700);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, watchedRepoUrl, watchedCredentialId]);

  useEffect(() => {
    if (!open) return;
    if (project) {
      form.setFieldsValue({
        name: project.name,
        description: project.description,
        repoUrl: project.repoUrl,
        credentialId: project.credentialId,
        defaultBranch: project.defaultBranch,
        buildEnabled: project.buildEnabled,
        buildCommand: project.buildCommand ?? '',
        targetRuntime: project.targetRuntime,
        artifactPath: project.artifactPath,
        excludePatterns: project.excludePatterns,
        buildTimeoutSec: project.buildTimeoutSec,
        deployTimeoutSec: project.deployTimeoutSec,
        onTargetFailure: project.onTargetFailure,
        keepWorkspace: project.keepWorkspace,
        targets: project.targets.map((target) => ({
          serverId: target.serverId,
          remoteDir: target.remoteDir,
          deployCommands: target.deployCommands,
          enabled: target.enabled,
        })),
        memberIds: project.members.map((member) => member.id),
      });
    } else {
      form.resetFields();
      form.setFieldsValue(DEFAULT_VALUES);
    }
  }, [open, project?.id, form]);

  const submit = async (values: ProjectFormValues) => {
    const targets = (values.targets ?? [])
      .filter((target) => target.serverId && target.remoteDir?.trim())
      .map((target) => ({
        serverId: Number(target.serverId),
        remoteDir: target.remoteDir!.trim(),
        deployCommands: target.deployCommands ?? '',
        enabled: target.enabled !== false,
      }));

    const payload: ProjectPayload = {
      name: values.name.trim(),
      description: values.description ?? '',
      repoUrl: values.repoUrl.trim(),
      credentialId: values.credentialId ?? null,
      defaultBranch: values.defaultBranch.trim(),
      buildEnabled: values.buildEnabled,
      buildCommand: values.buildEnabled ? (values.buildCommand ?? '') : null,
      targetRuntime: values.buildEnabled ? (values.targetRuntime ?? null) : null,
      artifactPath: values.artifactPath.trim(),
      excludePatterns: values.excludePatterns ?? [],
      buildTimeoutSec: values.buildTimeoutSec,
      deployTimeoutSec: values.deployTimeoutSec,
      onTargetFailure: values.onTargetFailure,
      keepWorkspace: values.keepWorkspace,
      targets,
      memberIds: values.memberIds,
    };

    try {
      const result = project ? await projectApi.update(project.id, payload) : await projectApi.create(payload);
      message.success(project ? '项目已更新' : '项目已创建');
      onSaved(result.project);
      onClose();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败');
    }
  };

  return (
    <Drawer
      title={project ? `编辑项目 · ${project.name}` : '新建项目'}
      width={780}
      open={open}
      onClose={onClose}
      destroyOnClose
      footer={
        <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" onClick={() => form.submit()} loading={false}>
            保存
          </Button>
        </Space>
      }
    >
      <Form form={form} layout="vertical" onFinish={submit} initialValues={DEFAULT_VALUES} requiredMark="optional">
        <Divider orientation="left" plain style={{ marginTop: 0 }}>
          基本信息
        </Divider>
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item name="name" label="项目名称" rules={[{ required: true, message: '请输入项目名称' }]}>
              <Input placeholder="例如：订单服务" maxLength={80} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="defaultBranch"
              label="默认分支"
              rules={[{ required: true, message: '请选择默认分支' }]}
              extra={
                <Space size={8} wrap>
                  {branchError ? (
                    <Typography.Text type="danger">{branchError}</Typography.Text>
                  ) : (
                    <Typography.Text type="secondary">
                      {branchOptions.length > 0
                        ? `已加载 ${branchOptions.length} 个远程分支`
                        : '填写仓库地址和 Git 凭据后自动加载'}
                    </Typography.Text>
                  )}
                  <Typography.Link onClick={() => void loadBranches()} disabled={branchLoading}>
                    {branchLoading ? '加载中...' : '刷新分支'}
                  </Typography.Link>
                </Space>
              }
            >
              <Select
                showSearch
                optionFilterProp="label"
                loading={branchLoading}
                placeholder={branchLoading ? '加载分支中...' : '请选择默认分支'}
                options={branchOptions.map((branch) => ({ value: branch, label: branch }))}
                notFoundContent={branchLoading ? '加载中...' : '暂无分支'}
                onChange={() => setBranchError(null)}
              />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="description" label="项目描述">
          <Input.TextArea rows={2} maxLength={1000} placeholder="选填，便于团队成员了解该项目" />
        </Form.Item>
        <Form.Item
          name="repoUrl"
          label="Git 仓库地址"
          rules={[{ required: true, message: '请输入仓库地址' }]}
          extra="支持 https://、ssh:// 或 git@host:path 形式"
        >
          <Input placeholder="git@github.com:org/repo.git" />
        </Form.Item>
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item name="credentialId" label="Git 凭据" extra="公开仓库可留空">
              <Select
                allowClear
                placeholder="选择凭据"
                options={credentials.map((item) => ({
                  value: item.id,
                  label: `${item.name} · ${item.authType === 'https_token' ? 'HTTPS Token' : 'SSH 私钥'}`,
                }))}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="keepWorkspace" label="发布失败时保留工作区" valuePropName="checked" extra="用于排查问题，需手工清理">
              <Switch />
            </Form.Item>
          </Col>
        </Row>

        <Divider orientation="left" plain>
          构建与产物
        </Divider>
        <Row gutter={16}>
          <Col span={8}>
            <Form.Item name="buildEnabled" label="执行构建" valuePropName="checked">
              <Switch checkedChildren="是" unCheckedChildren="否" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="buildTimeoutSec" label="构建超时（秒）" rules={[{ required: true }]}>
              <InputNumber min={30} max={86400} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="deployTimeoutSec" label="远程命令超时（秒）" rules={[{ required: true }]}>
              <InputNumber min={10} max={86400} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item noStyle shouldUpdate={(prev, next) => prev.buildEnabled !== next.buildEnabled}>
          {({ getFieldValue }) =>
            getFieldValue('buildEnabled') ? (
              <>
                <Form.Item
                  name="buildCommand"
                  label="构建命令"
                  rules={[{ required: true, message: '启用构建时必须填写构建命令' }]}
                  extra="在项目工作区根目录执行，例如 pnpm install && pnpm build"
                >
                  <Input.TextArea rows={3} className="mj-mono" placeholder="pnpm install && pnpm build" />
                </Form.Item>
                <Form.Item
                  name="targetRuntime"
                  label="目标运行时"
                  extra="仅影响 .NET 构建：设置后会向构建进程注入 RuntimeIdentifier 与 SelfContained=false，只生成该平台的原生依赖。部署到 Linux 建议选 linux-x64，可显著减小产物体积。"
                >
                  <Select
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    placeholder="不指定（保留构建机默认行为）"
                    options={RUNTIME_OPTIONS}
                  />
                </Form.Item>
              </>
            ) : null
          }
        </Form.Item>
        <Form.Item
          name="artifactPath"
          label="产物路径"
          rules={[{ required: true, message: '请输入产物路径' }]}
          extra="相对工作区路径，可填目录（如 dist）、单个文件或 glob（如 target/*.jar）；目录会连内容一起上传"
        >
          <Input placeholder="dist" />
        </Form.Item>
        <Form.Item name="excludePatterns" label="排除规则" extra="上传时忽略这些 glob，例如 **/*.map">
          <Select mode="tags" tokenSeparators={[',', ' ']} placeholder="输入后回车" open={false} suffixIcon={null} />
        </Form.Item>

        <Divider orientation="left" plain>
          发布目标
        </Divider>
        <Form.List
          name="targets"
          rules={[
            {
              validator: async (_, value: TargetFormValue[]) => {
                if (!value || value.length === 0) throw new Error('至少配置一个发布目标');
              },
            },
          ]}
        >
          {(fields, { add, remove }, { errors }) => (
            <>
              {fields.map((field, index) => (
                <Card
                  key={field.key}
                  size="small"
                  style={{ marginBottom: 12, background: '#fbfcfe' }}
                  title={`目标 ${index + 1}`}
                  extra={
                    fields.length > 1 ? (
                      <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={() => remove(field.name)}>
                        移除
                      </Button>
                    ) : null
                  }
                >
                  <Row gutter={12}>
                    <Col span={14}>
                      <Form.Item
                        name={[field.name, 'serverId']}
                        label="服务器"
                        rules={[{ required: true, message: '请选择服务器' }]}
                      >
                        <Select
                          placeholder="选择服务器"
                          options={servers.map((server) => ({
                            value: server.id,
                            label: `${server.name} · ${server.username}@${server.host}${server.trusted ? '' : '（未信任指纹）'}`,
                          }))}
                        />
                      </Form.Item>
                    </Col>
                    <Col span={10}>
                      <Form.Item name={[field.name, 'enabled']} label="启用" valuePropName="checked">
                        <Switch checkedChildren="启用" unCheckedChildren="停用" />
                      </Form.Item>
                    </Col>
                  </Row>
                  <Form.Item
                    name={[field.name, 'remoteDir']}
                    label="远程目录（绝对路径）"
                    rules={[{ required: true, message: '请输入远程目录' }]}
                  >
                    <Input className="mj-mono" placeholder="/opt/apps/order-service" />
                  </Form.Item>
                  <Form.Item
                    name={[field.name, 'deployCommands']}
                    label="上传后执行的命令"
                    extra="在目标机的该目录下执行，可留空；脚本退出码非 0 视为该目标失败"
                  >
                    <Input.TextArea rows={3} className="mj-mono" placeholder={'docker compose up -d --build\nnginx -s reload'} />
                  </Form.Item>
                </Card>
              ))}
              <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add({ enabled: true, remoteDir: '', deployCommands: '' })}>
                添加发布目标
              </Button>
              <Form.ErrorList errors={errors} />
            </>
          )}
        </Form.List>

        <Divider orientation="left" plain>
          发布策略
        </Divider>
        <Form.Item name="onTargetFailure" label="当某台服务器失败时">
          <Select
            options={[
              { value: 'abort', label: '立即中止，后续服务器标记为跳过' },
              { value: 'continue', label: '继续发布其余服务器，最后整体标记失败' },
            ]}
          />
        </Form.Item>

        {users.length > 0 ? (
          <>
            <Divider orientation="left" plain>
              普通成员授权
            </Divider>
            <Form.Item name="memberIds" label="可查看并发布该项目的普通成员" extra="管理员默认拥有全部权限">
              <Select
                mode="multiple"
                allowClear
                placeholder="选择成员"
                options={users.map((user) => ({
                  value: user.id,
                  label: `${user.displayName || user.username}（${user.username}）`,
                }))}
              />
            </Form.Item>
          </>
        ) : null}

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          提示：发布流程为 拉取分支 → 执行构建 → 收集产物 → 逐台 SFTP 上传 → 执行远程命令。
        </Typography.Text>
      </Form>
    </Drawer>
  );
}
