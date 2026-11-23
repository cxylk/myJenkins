import { Tag } from 'antd';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  MinusCircleOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import type { BuildStatus, TargetStatus } from '../types';

const BUILD_STATUS: Record<BuildStatus, { color: string; label: string }> = {
  queued: { color: 'default', label: '排队中' },
  running: { color: 'processing', label: '发布中' },
  success: { color: 'success', label: '成功' },
  failed: { color: 'error', label: '失败' },
  cancelled: { color: 'warning', label: '已取消' },
};

const TARGET_STATUS: Record<TargetStatus, { color: string; label: string }> = {
  queued: { color: 'default', label: '等待中' },
  running: { color: 'processing', label: '发布中' },
  success: { color: 'success', label: '成功' },
  failed: { color: 'error', label: '失败' },
  skipped: { color: 'default', label: '已跳过' },
  cancelled: { color: 'warning', label: '已取消' },
};

export function BuildStatusTag({ status }: { status: BuildStatus }) {
  const meta = BUILD_STATUS[status] ?? { color: 'default', label: status };
  const icon =
    status === 'running' ? (
      <SyncOutlined spin />
    ) : status === 'success' ? (
      <CheckCircleOutlined />
    ) : status === 'failed' ? (
      <CloseCircleOutlined />
    ) : status === 'queued' ? (
      <ClockCircleOutlined />
    ) : undefined;
  return (
    <Tag color={meta.color} icon={icon}>
      {meta.label}
    </Tag>
  );
}

export function TargetStatusTag({ status }: { status: TargetStatus }) {
  const meta = TARGET_STATUS[status] ?? { color: 'default', label: status };
  return (
    <Tag
      color={meta.color}
      icon={
        status === 'running' ? (
          <SyncOutlined spin />
        ) : status === 'skipped' ? (
          <MinusCircleOutlined />
        ) : undefined
      }
    >
      {meta.label}
    </Tag>
  );
}

export function RoleTag({ role }: { role: 'admin' | 'member' }) {
  return role === 'admin' ? <Tag color="gold">管理员</Tag> : <Tag>成员</Tag>;
}
