import { useEffect, useMemo, useRef, useState } from 'react';
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ArrowLeftOutlined, DownloadOutlined, StopOutlined } from '@ant-design/icons';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { buildApi } from '../api';
import { BuildStatusTag, TargetStatusTag } from '../components/StatusTag';
import { formatBytes, formatDuration, formatTime, shortSha, stripAnsi } from '../format';
import type { BuildTarget } from '../types';

const DISPLAY_LIMIT = 3 * 1024 * 1024;

function useBuildLog(buildId: number) {
  const [text, setText] = useState('');
  const [connected, setConnected] = useState(false);
  const [ended, setEnded] = useState(false);
  const offsetRef = useRef(0);
  const truncatedRef = useRef(false);

  useEffect(() => {
    let source: EventSource | null = null;
    let disposed = false;
    offsetRef.current = 0;
    truncatedRef.current = false;
    setText('');
    setEnded(false);
    setConnected(false);

    const append = (chunk: string, nextOffset: number) => {
      if (!chunk) return;
      offsetRef.current = nextOffset;
      setText((previous) => {
        let next = previous + chunk;
        if (next.length > DISPLAY_LIMIT) {
          next = `…（日志过长，仅显示最近部分）\n${next.slice(next.length - DISPLAY_LIMIT)}`;
          truncatedRef.current = true;
        }
        return next;
      });
    };

    const connect = async () => {
      try {
        const initial = await buildApi.log(buildId, 0, 512 * 1024);
        if (disposed) return;
        append(initial.content, initial.offset);
        if (!initial.running && initial.offset >= initial.size) {
          setEnded(true);
          return;
        }
        source = new EventSource(`/api/builds/${buildId}/events?offset=${offsetRef.current}`);
        source.onopen = () => setConnected(true);
        source.onmessage = (event) => {
          try {
            const payload = JSON.parse(event.data) as { offset: number; text: string };
            append(payload.text, payload.offset);
          } catch {
            /* ignore malformed frame */
          }
        };
        source.addEventListener('end', () => {
          setEnded(true);
          setConnected(false);
          source?.close();
          source = null;
        });
        source.onerror = () => setConnected(false);
      } catch {
        setConnected(false);
      }
    };

    void connect();
    return () => {
      disposed = true;
      source?.close();
    };
  }, [buildId]);

  return { text, connected, ended };
}

export default function BuildDetailPage() {
  const params = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { message, modal } = AntdApp.useApp();
  const buildId = Number(params.buildId);
  const [autoScroll, setAutoScroll] = useState(true);
  const logRef = useRef<HTMLPreElement>(null);

  const buildQuery = useQuery({
    queryKey: ['build', buildId],
    queryFn: () => buildApi.get(buildId),
    enabled: Number.isFinite(buildId),
    refetchInterval: (query) => {
      const status = query.state.data?.build.status;
      return status === 'queued' || status === 'running' ? 2000 : false;
    },
  });

  const build = buildQuery.data?.build;
  const { text, connected, ended } = useBuildLog(buildId);
  const display = useMemo(() => stripAnsi(text), [text]);

  useEffect(() => {
    if (!autoScroll) return;
    const element = logRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [display, autoScroll]);

  if (buildQuery.isLoading) {
    return <Card loading />;
  }

  if (!build) {
    return (
      <Card>
        <Empty description={buildQuery.error instanceof Error ? buildQuery.error.message : '发布记录不存在'} />
        <div style={{ textAlign: 'center' }}>
          <Button onClick={() => navigate('/projects')}>返回</Button>
        </div>
      </Card>
    );
  }

  const cancel = () => {
    modal.confirm({
      title: '取消本次发布？',
      content: '正在执行的构建进程或远程命令会被中断，目标服务器上已上传的文件不会回滚。',
      okText: '取消发布',
      okButtonProps: { danger: true },
      cancelText: '继续等待',
      onOk: async () => {
        try {
          await buildApi.cancel(buildId);
          message.success('已发送取消请求');
          void queryClient.invalidateQueries({ queryKey: ['build', buildId] });
        } catch (error) {
          message.error(error instanceof Error ? error.message : '取消失败');
        }
      },
    });
  };

  const targetColumns: ColumnsType<BuildTarget> = [
    {
      title: '服务器',
      dataIndex: 'serverName',
      width: 200,
      render: (value: string, target) => (
        <div>
          <div style={{ fontWeight: 500 }}>{value}</div>
          <div className="mj-muted mj-mono" style={{ fontSize: 12 }}>
            {target.remoteDir}
          </div>
        </div>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: BuildTarget['status']) => <TargetStatusTag status={value} />,
    },
    {
      title: '文件',
      dataIndex: 'filesUploaded',
      width: 180,
      render: (value: number, target) => (target.status === 'success' || value > 0 ? `${value} 个 / ${formatBytes(target.bytesUploaded)}` : '-'),
    },
    {
      title: '耗时',
      dataIndex: 'durationMs',
      width: 100,
      render: (value: number | null) => (value === null ? '-' : formatDuration(value)),
    },
    {
      title: '错误',
      dataIndex: 'error',
      ellipsis: true,
      render: (value: string | null) =>
        value ? (
          <Tooltip title={value}>
            <Typography.Text type="danger" ellipsis style={{ maxWidth: 280 }}>
              {value}
            </Typography.Text>
          </Tooltip>
        ) : (
          <span className="mj-muted">-</span>
        ),
    },
  ];

  return (
    <div>
      <Space size={4} style={{ marginBottom: 8 }}>
        <Button type="text" size="small" icon={<ArrowLeftOutlined />} onClick={() => navigate(`/projects/${build.projectId}`)}>
          返回项目
        </Button>
      </Space>

      <div className="mj-page-header">
        <div>
          <h1 className="mj-page-title">
            {build.projectName} <span className="mj-mono mj-muted">#{build.number}</span>
          </h1>
          <Space size={8} wrap style={{ marginTop: 6 }}>
            <BuildStatusTag status={build.status} />
            <Tag className="mj-mono">{build.branch}</Tag>
            <span className="mj-muted mj-mono">{shortSha(build.commitSha)}</span>
            {build.commitSubject ? <span className="mj-muted">{build.commitSubject}</span> : null}
          </Space>
        </div>
        <Space wrap>
          {build.canCancel ? (
            <Button danger icon={<StopOutlined />} onClick={cancel}>
              取消发布
            </Button>
          ) : null}
          <Button
            icon={<DownloadOutlined />}
            href={`/api/builds/${buildId}/log/download`}
            disabled={!build.logSize}
          >
            下载日志
          </Button>
        </Space>
      </div>

      {build.status === 'failed' && build.error ? (
        <Alert type="error" showIcon message="发布失败" description={build.error} style={{ marginBottom: 16 }} />
      ) : null}
      {build.status === 'cancelled' ? (
        <Alert type="warning" showIcon message="发布已取消" style={{ marginBottom: 16 }} />
      ) : null}

      <Card className="mj-card" style={{ marginTop: 0 }}>
        <Descriptions column={{ xs: 1, sm: 2, md: 3 }} size="middle">
          <Descriptions.Item label="触发人">{build.triggeredBy || '未知'}</Descriptions.Item>
          <Descriptions.Item label="开始时间">{formatTime(build.startedAt)}</Descriptions.Item>
          <Descriptions.Item label="结束时间">{formatTime(build.finishedAt)}</Descriptions.Item>
          <Descriptions.Item label="耗时">{formatDuration(build.durationMs)}</Descriptions.Item>
          <Descriptions.Item label="提交">
            <span className="mj-mono">{build.commitSha || '-'}</span>
          </Descriptions.Item>
          <Descriptions.Item label="日志大小">{formatBytes(build.logSize)}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card
        className="mj-card"
        title={`目标服务器（${build.targets.length}）`}
        styles={{ body: { padding: build.targets.length === 0 ? 24 : 0 } }}
      >
        {build.targets.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有发布目标" />
        ) : (
          <Table<BuildTarget>
            rowKey="id"
            size="middle"
            columns={targetColumns}
            dataSource={build.targets}
            pagination={false}
          />
        )}
      </Card>

      <Card
        className="mj-card"
        title="执行日志"
        extra={
          <Space size={12} wrap>
            {connected ? <Tag color="processing">实时连接中</Tag> : ended ? <Tag>已结束</Tag> : <Tag>连接中…</Tag>}
            <Space size={6}>
              <span className="mj-muted" style={{ fontSize: 12 }}>
                自动滚动
              </span>
              <Switch size="small" checked={autoScroll} onChange={setAutoScroll} />
            </Space>
          </Space>
        }
        styles={{ body: { paddingTop: 12 } }}
      >
        <div className="mj-log-toolbar">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {build.status === 'queued' ? '发布排队中，等待执行…' : '日志随执行实时输出，刷新页面不会丢失'}
          </Typography.Text>
          <Link to={`/projects/${build.projectId}`} className="mj-muted" style={{ fontSize: 12 }}>
            查看项目配置
          </Link>
        </div>
        <pre className="mj-log" ref={logRef}>
          {display || <span className="mj-log-placeholder">等待日志输出…</span>}
        </pre>
      </Card>
    </div>
  );
}
