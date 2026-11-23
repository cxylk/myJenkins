import { useEffect, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Checkbox,
  Form,
  Input,
  Modal,
  Popconfirm,
  Radio,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PlusOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { credentialApi } from '../api';
import { PageHeader } from '../components/AppLayout';
import { formatTime } from '../format';
import type { Credential } from '../types';

interface CredentialFormValues {
  name: string;
  authType: 'https_token' | 'ssh_key';
  username?: string;
  secret?: string;
  passphrase?: string;
  clearPassphrase?: boolean;
}

export default function CredentialsPage() {
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<CredentialFormValues>();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Credential | null>(null);
  const [saving, setSaving] = useState(false);

  const credentialsQuery = useQuery({ queryKey: ['credentials'], queryFn: credentialApi.list });
  const credentials = credentialsQuery.data?.credentials ?? [];

  useEffect(() => {
    if (!open) return;
    if (editing) {
      form.setFieldsValue({
        name: editing.name,
        authType: editing.authType,
        username: editing.username ?? '',
        secret: '',
        passphrase: '',
        clearPassphrase: false,
      });
    } else {
      form.resetFields();
      form.setFieldsValue({ authType: 'https_token' });
    }
  }, [open, editing, form]);

  const save = async (values: CredentialFormValues) => {
    if (!editing && !values.secret?.trim()) {
      message.warning('请填写 Token 或私钥');
      return;
    }
    const payload: Record<string, unknown> = {
      name: values.name,
      authType: values.authType,
      username: values.username || null,
    };
    if (values.secret) payload.secret = values.secret;
    if (values.passphrase) payload.passphrase = values.passphrase;
    if (values.clearPassphrase) payload.clearPassphrase = true;

    setSaving(true);
    try {
      if (editing) await credentialApi.update(editing.id, payload);
      else await credentialApi.create(payload);
      message.success(editing ? '凭据已更新' : '凭据已创建');
      setOpen(false);
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: ['credentials'] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (credential: Credential) => {
    try {
      await credentialApi.remove(credential.id);
      message.success('凭据已删除');
      void queryClient.invalidateQueries({ queryKey: ['credentials'] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : '删除失败');
    }
  };

  const columns: ColumnsType<Credential> = [
    { title: '名称', dataIndex: 'name', render: (value: string) => <span style={{ fontWeight: 500 }}>{value}</span> },
    {
      title: '类型',
      dataIndex: 'authType',
      width: 150,
      render: (value: Credential['authType']) =>
        value === 'https_token' ? <Tag color="blue">HTTPS Token</Tag> : <Tag color="geekblue">SSH 私钥</Tag>,
    },
    { title: '用户名', dataIndex: 'username', width: 160, render: (value: string | null) => value || '-' },
    {
      title: '口令',
      dataIndex: 'hasPassphrase',
      width: 100,
      render: (value: boolean) => (value ? <Tag>已设置</Tag> : <span className="mj-muted">-</span>),
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 170,
      render: (value: string) => formatTime(value, 'YYYY-MM-DD HH:mm'),
    },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      render: (_, record) => (
        <Space size={2}>
          <Button
            type="link"
            size="small"
            onClick={() => {
              setEditing(record);
              setOpen(true);
            }}
          >
            编辑
          </Button>
          <Popconfirm
            title="删除凭据？"
            description="仍被项目使用的凭据无法删除"
            okText="删除"
            okButtonProps={{ danger: true }}
            onConfirm={() => void remove(record)}
          >
            <Button type="link" size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Git 凭据"
        subtitle="用于拉取私有仓库的 HTTPS Token 或 SSH 私钥，加密存储且不会回显"
        extra={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          >
            添加凭据
          </Button>
        }
      />

      <Table<Credential>
        rowKey="id"
        columns={columns}
        dataSource={credentials}
        loading={credentialsQuery.isLoading}
        pagination={false}
        locale={{ emptyText: '还没有 Git 凭据，公开仓库可以不配置' }}
      />

      <Modal
        title={editing ? `编辑凭据 · ${editing.name}` : '添加 Git 凭据'}
        open={open}
        onCancel={() => {
          setOpen(false);
          setEditing(null);
        }}
        onOk={() => form.submit()}
        confirmLoading={saving}
        okText="保存"
        width={620}
        styles={{ body: { maxHeight: 'calc(100vh - 220px)', overflowY: 'auto' } }}
      >
        <Form form={form} layout="vertical" onFinish={save} requiredMark="optional">
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如：GitLab 只读 Token" maxLength={80} />
          </Form.Item>
          <Form.Item name="authType" label="类型" rules={[{ required: true }]}>
            <Radio.Group
              optionType="button"
              options={[
                { value: 'https_token', label: 'HTTPS Token' },
                { value: 'ssh_key', label: 'SSH 私钥' },
              ]}
            />
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(prev, next) => prev.authType !== next.authType}
          >
            {({ getFieldValue }) =>
              getFieldValue('authType') === 'ssh_key' ? (
                <>
                  <Form.Item
                    name="secret"
                    label="私钥内容"
                    rules={editing ? [] : [{ required: true, message: '请粘贴私钥' }]}
                    extra={editing ? '留空表示不修改已保存的私钥' : '粘贴完整的 PEM/OpenSSH 私钥'}
                  >
                    <Input.TextArea rows={7} className="mj-mono" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
                  </Form.Item>
                  <Form.Item name="passphrase" label="私钥口令">
                    <Input.Password placeholder="私钥无口令时留空" autoComplete="new-password" />
                  </Form.Item>
                  {editing ? (
                    <Form.Item name="clearPassphrase" valuePropName="checked">
                      <Checkbox>清除已保存的私钥口令</Checkbox>
                    </Form.Item>
                  ) : null}
                </>
              ) : (
                <>
                  <Form.Item
                    name="username"
                    label="用户名"
                    rules={[{ required: true, message: '请输入用户名' }]}
                    extra="多数平台填 git 或任意占位用户名，Token 作为密码"
                  >
                    <Input placeholder="git" />
                  </Form.Item>
                  <Form.Item
                    name="secret"
                    label="Token"
                    rules={editing ? [] : [{ required: true, message: '请输入 Token' }]}
                    extra={editing ? '留空表示不修改已保存的 Token' : '建议使用只读权限的访问令牌'}
                  >
                    <Input.Password placeholder={editing ? '••••••••' : 'ghp_xxx / glpat-xxx'} autoComplete="new-password" />
                  </Form.Item>
                </>
              )
            }
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            凭据使用 AES-256-GCM 加密后保存在数据库中，接口只返回名称与类型。
          </Typography.Text>
        </Form>
      </Modal>
    </div>
  );
}
