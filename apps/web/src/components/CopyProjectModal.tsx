import { useEffect, useState } from 'react';
import { App as AntdApp, Form, Input, Modal, Typography } from 'antd';
import { projectApi } from '../api';
import type { Project } from '../types';

interface Props {
  open: boolean;
  project: { id: number; name: string } | null;
  onClose: () => void;
  onCopied: (project: Project) => void;
}

export function CopyProjectModal({ open, project, onClose, onCopied }: Props) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<{ name: string }>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !project) return;
    form.setFieldsValue({ name: `${project.name} 副本` });
  }, [open, project, form]);

  const submit = async (values: { name: string }) => {
    if (!project) return;
    setSaving(true);
    try {
      const result = await projectApi.copy(project.id, values.name.trim());
      message.success(`已复制为「${result.project.name}」`);
      onCopied(result.project);
      onClose();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '复制失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={project ? `复制项目 · ${project.name}` : '复制项目'}
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={saving}
      okText="复制"
      cancelText="取消"
      destroyOnClose
    >
      <Form form={form} layout="vertical" onFinish={submit}>
        <Form.Item
          name="name"
          label="新项目名称"
          rules={[
            { required: true, message: '请输入新项目名称' },
            { max: 80, message: '最多 80 个字符' },
          ]}
        >
          <Input autoFocus maxLength={80} />
        </Form.Item>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          将复制仓库地址、Git 凭据、分支、构建配置、产物配置、全部发布目标与成员授权；不会复制历史发布记录和日志。
        </Typography.Text>
      </Form>
    </Modal>
  );
}
