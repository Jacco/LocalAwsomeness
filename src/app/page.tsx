'use client';

import Image from "next/image";
import { RadioGroup, Label, Radio } from '@headlessui/react'
import { useState } from "react";

const addCommentHandler = () => {
  fetch("api/account/getAccountInformation", {
      method: 'POST',
      headers: new Headers({
          'Accept': 'application/json',
          'Content-Type': 'application/json'
      }),
  })
  .then(response => response.json())
  .then(data => {
      // let updatedComments = comments;
      // updatedComments.push(data)
      // setComments([...comments], updatedComments);

      // setLoading(false);
      // setError(null);
  })
  .catch(error => {
      console.error(error);
      // setLoading(false);
      // setError('Something went wrong, please try again later.');
  });
}

interface MyRadioGroupProps {
  plan: string
  setPlan: (event: any) => void
}

function MyRadioGroup({ plan, setPlan }: MyRadioGroupProps) {
  return (
    <RadioGroup value={plan} onChange={setPlan}>
      <Label>Plan</Label>
      <Radio value="startup">
        {({ checked }) => (
          <span className={checked ? 'bg-blue-200' : ''}>Startup</span>
        )}
      </Radio>
      <Radio value="business">
        {({ checked }) => (
          <span className={checked ? 'bg-blue-200' : ''}>Business</span>
        )}
      </Radio>
      <Radio value="enterprise">
        {({ checked }) => (
          <span className={checked ? 'bg-blue-200' : ''}>Enterprise</span>
        )}
      </Radio>
    </RadioGroup>
  )
}

export default function Home() {
  let [plan, setPlan] = useState('startup')
  
  return (
    <>
      <MyRadioGroup plan={plan} setPlan={setPlan} />
      {plan == 'enterprise' && <div>
        
      </div>}
      <div>select account / region</div>
      <div>IAM / Organizations / Account</div>
      <div>ec2 / efs</div>
    </>
  );
}
