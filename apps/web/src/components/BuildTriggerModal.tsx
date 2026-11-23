import { useEffect, useState } from 'react';
import { App as AntdApp, Alert, Button, Empty, Modal, Select, Space, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ApiError, buildApi, projectApi } from '../api';

interface Props {
  open: boolean;
  project: { id: number; name: string; defaultBranch: string } | null;
  onClose: () => void;
}

export function BuildTriggerModal({ open, project, onClose }: Props) {
  const { message } = AntdApp.useApp();
  const navigate = useNavigate();
  const [branch, setBranch] = useState<string | undefined>();
  const [refreshToken, setRefreshToken] = useState(0);
  const [loading, setLoading] = useState(false);

  const branchesQuery = useQuery({
    queryKey: ['branches', project?.id, refreshToken],
    queryFn: () => projectApi.branches(project!.id, refreshToken > 0),
    enabled: open && Boolean(project),
    retry: false,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (open && project) {
      setBranch(project.defaultBranch);
      setRefreshToken(0);
    }
  }, [open, project]);

  const branches = branchesQuery.data?.branches ?? [];
  const error = branchesQuery.error;

  const trigger = async () => {
    if (!project || !branch) {
      message.warning('请选择要发布的分支');
      return;
    }
    setLoading(true);
    try {
      const result = await buildApi.trigger(project.id, branch);
      message.success(`已创建发布 #${result.build.number}`);
      onClose();
      navigate(`/projects/${project.id}/builds/${result.build.id}`);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '创建发布失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title={project ? `发布 · ${project.name}` : '发布'}
      open={open}
      onCancel={onClose}
      onOk={trigger}
      okText="开始发布"
      confirmLoading={loading}
      okButtonProps={{ disabled: branchesQuery.isLoading || branches.length === 0 }}
      destroyOnClose
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Typography.Text type="secondary">
          选择要发布的分支，系统会拉取该分支最新提交，依次执行构建、上传与远程命令。
        </Typography.Text>
        {error ? (
          <Alert
            type="error"
            showIcon
            message="加载分支失败"
            description={error instanceof ApiError ? error.message : String(error)}
            action={
              <Button size="small" onClick={() => setRefreshToken((value) => value + 1)}>
                重试
              </Button>
            }
          />
        ) : null}
        <Space.Compact style={{ width: '100%' }}>
          <Select
            style={{ width: '100%' }}
            showSearch
            loading={branchesQuery.isFetching}
            placeholder="选择分支"
            value={branch}
            onChange={setBranch}
            optionFilterProp="label"
            options={branches.map((item) => ({ value: item, label: item }))}
            notFoundContent={
              branchesQuery.isLoading ? '加载中...' : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有分支" />
            }
          />
          <Button
            icon={<ReloadOutlined />}
            onClick={() => setRefreshToken((value) => value + 1)}
            loading={branchesQuery.isFetching}
            title="刷新分支列表"
          />
        </Space.Compact>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          从远程仓库实时读取分支，创建发布后不可修改分支。
        </Typography.Text>
      </Space>
    </Modal>
  );
}
