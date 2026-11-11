'use client';

import { useState } from 'react';
import styles from '../../accounts.module.css';

export interface ResourceFormProps {
  resourceType: string;
  data: any;
  onSave: (data: any) => void;
  onCancel: () => void;
}

// SSM Parameter form
export function SSMParameterForm({ data, onSave, onCancel }: ResourceFormProps) {
  const [name, setName] = useState(data.Name || '');
  const [value, setValue] = useState(data.Value || '');
  const [type, setType] = useState(data.Type || 'String');
  const [tier, setTier] = useState(data.Tier || 'Standard');

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    onSave({
      ...data,
      Name: name,
      Value: value,
      Type: type,
      Tier: tier,
    });
  };

  return (
    <form onSubmit={handleSubmit} className={styles.resourceForm}>
      <div className={styles.formGroup}>
        <label htmlFor="Name">Parameter Name</label>
        <input 
          type="text" 
          id="Name" 
          name="Name" 
          value={name}
          onChange={(e) => setName(e.target.value)}
          required 
        />
      </div>
      <div className={styles.formGroup}>
        <label htmlFor="Value">Parameter Value</label>
        <textarea 
          id="Value" 
          name="Value" 
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={4} 
          required 
        />
      </div>
      <div className={styles.formGroup}>
        <label htmlFor="Type">Type</label>
        <select 
          id="Type" 
          name="Type" 
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          <option>String</option>
          <option>StringList</option>
          <option>SecureString</option>
        </select>
      </div>
      <div className={styles.formGroup}>
        <label htmlFor="Tier">Tier</label>
        <select 
          id="Tier" 
          name="Tier" 
          value={tier}
          onChange={(e) => setTier(e.target.value)}
        >
          <option>Standard</option>
          <option>Advanced</option>
        </select>
      </div>
      <div className={styles.editActions}>
        <button type="submit" className={styles.saveButton}>Save</button>
        <button type="button" className={styles.cancelButton} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// IAM Role form
export function IAMRoleForm({ data, onSave, onCancel }: ResourceFormProps) {
  const [roleName, setRoleName] = useState(data.roleName || '');
  const [path, setPath] = useState(data.path || '/');

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    onSave({
      ...data,
      roleName: roleName,
      path: path,
    });
  };

  return (
    <form onSubmit={handleSubmit} className={styles.resourceForm}>
      <div className={styles.formGroup}>
        <label htmlFor="roleName">Role Name</label>
        <input 
          type="text" 
          id="roleName" 
          name="roleName" 
          value={roleName}
          onChange={(e) => setRoleName(e.target.value)}
          required 
        />
      </div>
      <div className={styles.formGroup}>
        <label htmlFor="path">Path</label>
        <input 
          type="text" 
          id="path" 
          name="path" 
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
      </div>
      <div className={styles.formGroup}>
        <label htmlFor="arn">ARN (read-only)</label>
        <input type="text" id="arn" value={data.arn || ''} disabled />
      </div>
      <div className={styles.formGroup}>
        <label htmlFor="roleId">Role ID (read-only)</label>
        <input type="text" id="roleId" value={data.roleId || ''} disabled />
      </div>
      <details className={styles.formDetails}>
        <summary>Attached Policies</summary>
        <div className={styles.policyList}>
          {(data.attachedPolicies || []).map((policy: string, idx: number) => (
            <div key={idx} className={styles.policyItem}>{policy}</div>
          ))}
        </div>
      </details>
      <div className={styles.editActions}>
        <button type="submit" className={styles.saveButton}>Save</button>
        <button type="button" className={styles.cancelButton} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// S3 Object form
export function S3ObjectForm({ data, onSave, onCancel }: ResourceFormProps) {
  return (
    <div className={styles.resourceForm}>
      <div className={styles.formGroup}>
        <label>Key</label>
        <input type="text" value={data.Key || ''} disabled />
      </div>
      <div className={styles.formGroup}>
        <label>Size</label>
        <input type="text" value={`${data.Size || 0} bytes`} disabled />
      </div>
      <div className={styles.formGroup}>
        <label>Content Type</label>
        <input type="text" value={data.ContentType || ''} disabled />
      </div>
      <div className={styles.formGroup}>
        <label>Last Modified</label>
        <input type="text" value={new Date(data.LastModified || '').toISOString()} disabled />
      </div>
      <div className={styles.formGroup}>
        <label>Content Preview</label>
        <textarea value={data.Body || ''} disabled rows={6} />
      </div>
      <div className={styles.editActions}>
        <button type="button" className={styles.cancelButton} onClick={onCancel}>Close</button>
      </div>
    </div>
  );
}

// Generic JSON form fallback
export function GenericResourceForm({ data, onSave, onCancel }: ResourceFormProps) {
  const [json, setJson] = useState(JSON.stringify(data, null, 2));

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      onSave(JSON.parse(json));
    } catch {
      alert('Invalid JSON');
    }
  };

  return (
    <form onSubmit={handleSubmit} className={styles.resourceForm}>
      <div className={styles.formGroup}>
        <label htmlFor="json">Resource Data (JSON)</label>
        <textarea
          id="json"
          name="json"
          value={json}
          onChange={(e) => setJson(e.target.value)}
          rows={12}
          className={styles.jsonEditor}
          required
        />
      </div>
      <div className={styles.editActions}>
        <button type="submit" className={styles.saveButton}>Save</button>
        <button type="button" className={styles.cancelButton} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// KMS Key form
export function KMSKeyForm({ data, onSave, onCancel }: ResourceFormProps) {
  const [description, setDescription] = useState(data.Description || '');
  const [keyUsage, setKeyUsage] = useState(data.KeyUsage || 'ENCRYPT_DECRYPT');
  const [keyState, setKeyState] = useState(data.KeyState || 'Enabled');

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    onSave({
      ...data,
      Description: description,
      KeyUsage: keyUsage,
      KeyState: keyState,
    });
  };

  return (
    <form onSubmit={handleSubmit} className={styles.resourceForm}>
      <div className={styles.formGroup}>
        <label htmlFor="Description">Description</label>
        <textarea 
          id="Description" 
          name="Description" 
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
        />
      </div>
      <div className={styles.formGroup}>
        <label htmlFor="KeyUsage">Key Usage</label>
        <select 
          id="KeyUsage" 
          name="KeyUsage" 
          value={keyUsage}
          onChange={(e) => setKeyUsage(e.target.value)}
        >
          <option>ENCRYPT_DECRYPT</option>
          <option>SIGN_VERIFY</option>
        </select>
      </div>
      <div className={styles.formGroup}>
        <label htmlFor="KeyState">Key State</label>
        <select 
          id="KeyState" 
          name="KeyState" 
          value={keyState}
          onChange={(e) => setKeyState(e.target.value)}
        >
          <option>Enabled</option>
          <option>Disabled</option>
        </select>
      </div>
      <div className={styles.editActions}>
        <button type="submit" className={styles.saveButton}>Save</button>
        <button type="button" className={styles.cancelButton} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// CloudWatch Log Group form
export function CloudWatchLogGroupForm({ data, onSave, onCancel }: ResourceFormProps) {
  const [logGroupName, setLogGroupName] = useState(data.logGroupName || '');
  const [retentionInDays, setRetentionInDays] = useState(data.retentionInDays?.toString() || '');

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    onSave({
      ...data,
      logGroupName: logGroupName,
      retentionInDays: retentionInDays ? parseInt(retentionInDays) : undefined,
    });
  };

  return (
    <form onSubmit={handleSubmit} className={styles.resourceForm}>
      <div className={styles.formGroup}>
        <label htmlFor="logGroupName">Log Group Name</label>
        <input 
          type="text" 
          id="logGroupName" 
          name="logGroupName" 
          value={logGroupName}
          onChange={(e) => setLogGroupName(e.target.value)}
          required 
        />
      </div>
      <div className={styles.formGroup}>
        <label htmlFor="retentionInDays">Retention (days)</label>
        <input 
          type="number" 
          id="retentionInDays" 
          name="retentionInDays" 
          value={retentionInDays}
          onChange={(e) => setRetentionInDays(e.target.value)}
          min="1"
          max="3653"
        />
      </div>
      <div className={styles.editActions}>
        <button type="submit" className={styles.saveButton}>Save</button>
        <button type="button" className={styles.cancelButton} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// CloudWatch Alarm form
export function CloudWatchAlarmForm({ data, onSave, onCancel }: ResourceFormProps) {
  const [alarmName, setAlarmName] = useState(data.AlarmName || '');
  const [alarmDescription, setAlarmDescription] = useState(data.AlarmDescription || '');
  const [threshold, setThreshold] = useState(data.Threshold?.toString() || '');

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    onSave({
      ...data,
      AlarmName: alarmName,
      AlarmDescription: alarmDescription,
      Threshold: threshold ? parseFloat(threshold) : 0,
    });
  };

  return (
    <form onSubmit={handleSubmit} className={styles.resourceForm}>
      <div className={styles.formGroup}>
        <label htmlFor="AlarmName">Alarm Name</label>
        <input 
          type="text" 
          id="AlarmName" 
          name="AlarmName" 
          value={alarmName}
          onChange={(e) => setAlarmName(e.target.value)}
          required 
        />
      </div>
      <div className={styles.formGroup}>
        <label htmlFor="AlarmDescription">Description</label>
        <textarea 
          id="AlarmDescription" 
          name="AlarmDescription" 
          value={alarmDescription}
          onChange={(e) => setAlarmDescription(e.target.value)}
          rows={3}
        />
      </div>
      <div className={styles.formGroup}>
        <label htmlFor="Threshold">Threshold</label>
        <input 
          type="number" 
          id="Threshold" 
          name="Threshold" 
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
          step="0.1"
          required 
        />
      </div>
      <div className={styles.editActions}>
        <button type="submit" className={styles.saveButton}>Save</button>
        <button type="button" className={styles.cancelButton} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// VPC form
export function VPCForm({ data, onSave, onCancel }: ResourceFormProps) {
  const [cidrBlock, setCidrBlock] = useState(data.CidrBlock || '');
  const [vpcName, setVpcName] = useState(data.Tags?.find((t: any) => t.Key === 'Name')?.Value || '');
  const [vpcState, setVpcState] = useState(data.State || 'available');

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const tags = data.Tags ? [...data.Tags] : [];
    const nameTag = tags.find((t: any) => t.Key === 'Name');
    if (nameTag) {
      nameTag.Value = vpcName;
    } else if (vpcName) {
      tags.push({ Key: 'Name', Value: vpcName });
    }
    
    onSave({
      ...data,
      CidrBlock: cidrBlock,
      State: vpcState,
      Tags: tags,
    });
  };

  return (
    <form onSubmit={handleSubmit} className={styles.resourceForm}>
      <div className={styles.formGroup}>
        <label htmlFor="vpcName">VPC Name</label>
        <input 
          type="text" 
          id="vpcName" 
          name="vpcName" 
          value={vpcName}
          onChange={(e) => setVpcName(e.target.value)}
        />
      </div>
      <div className={styles.formGroup}>
        <label htmlFor="CidrBlock">CIDR Block</label>
        <input 
          type="text" 
          id="CidrBlock" 
          name="CidrBlock" 
          value={cidrBlock}
          onChange={(e) => setCidrBlock(e.target.value)}
          required 
        />
      </div>
      <div className={styles.formGroup}>
        <label htmlFor="vpcState">State</label>
        <select 
          id="vpcState" 
          name="vpcState" 
          value={vpcState}
          onChange={(e) => setVpcState(e.target.value)}
        >
          <option>available</option>
          <option>pending</option>
        </select>
      </div>
      <div className={styles.editActions}>
        <button type="submit" className={styles.saveButton}>Save</button>
        <button type="button" className={styles.cancelButton} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// Subnet form
export function SubnetForm({ data, onSave, onCancel }: ResourceFormProps) {
  const [subnetName, setSubnetName] = useState(data.Tags?.find((t: any) => t.Key === 'Name')?.Value || '');
  const [cidrBlock, setCidrBlock] = useState(data.CidrBlock || '');

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const tags = data.Tags ? [...data.Tags] : [];
    const nameTag = tags.find((t: any) => t.Key === 'Name');
    if (nameTag) {
      nameTag.Value = subnetName;
    } else if (subnetName) {
      tags.push({ Key: 'Name', Value: subnetName });
    }
    
    onSave({
      ...data,
      CidrBlock: cidrBlock,
      Tags: tags,
    });
  };

  return (
    <form onSubmit={handleSubmit} className={styles.resourceForm}>
      <div className={styles.formGroup}>
        <label htmlFor="subnetName">Subnet Name</label>
        <input 
          type="text" 
          id="subnetName" 
          name="subnetName" 
          value={subnetName}
          onChange={(e) => setSubnetName(e.target.value)}
        />
      </div>
      <div className={styles.formGroup}>
        <label htmlFor="CidrBlock">CIDR Block</label>
        <input 
          type="text" 
          id="CidrBlock" 
          name="CidrBlock" 
          value={cidrBlock}
          onChange={(e) => setCidrBlock(e.target.value)}
          required 
        />
      </div>
      <div className={styles.editActions}>
        <button type="submit" className={styles.saveButton}>Save</button>
        <button type="button" className={styles.cancelButton} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export function getFormComponent(resourceType: string, data: any) {
  const type = resourceType.toLowerCase();
  
  if (type === 'ssm') return SSMParameterForm;
  if (type === 'iam') return IAMRoleForm;
  if (type === 's3') return S3ObjectForm;
  if (type === 'kms') return KMSKeyForm;
  if (type === 'cloudwatch') {
    // Determine if it's a log group or alarm based on data structure
    if (data.logGroupName) return CloudWatchLogGroupForm;
    if (data.AlarmName) return CloudWatchAlarmForm;
    return GenericResourceForm;
  }
  if (type === 'vpc') {
    // Determine if it's a VPC or Subnet based on data structure
    if (data.SubnetId) return SubnetForm;
    if (data.VpcId) return VPCForm;
    return GenericResourceForm;
  }
  
  return GenericResourceForm;
}
