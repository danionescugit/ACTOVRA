// Synthetic/demo data for opportunities
// In a real application, this might come from a database or external service
// For the hackathon, we use hardcoded/demo data only.

import { Opportunity } from './schemas';

export const syntheticOpportunities: Opportunity[] = [
  {
    id: 'opp-001',
    title: 'Summer Promotion Discount',
    description: 'Offer 10% discount to high-value customers for summer season',
  },
  {
    id: 'opp-002',
    title: 'Bulk Purchase Incentive',
    description: 'Provide $50 rebate for orders over $500',
  },
  {
    id: 'opp-003',
    title: 'New Customer Welcome',
    description: 'Give $25 credit to first-time customers',
  },
];