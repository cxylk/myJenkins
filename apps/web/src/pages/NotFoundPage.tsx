import { Button, Result } from 'antd';
import { useNavigate } from 'react-router-dom';

export default function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <Result
      status="404"
      title="页面不存在"
      subTitle="请检查地址是否正确，或返回项目列表。"
      extra={
        <Button type="primary" onClick={() => navigate('/projects')}>
          返回项目列表
        </Button>
      }
    />
  );
}
