import { defineStore } from "pinia";

type CustomerCategoryEntry = {
  entryId: string;
  categoryKey: string;
  category: string;
  enteredAt: string;
};

export const useCustomerJourneyStore = defineStore("customer-journey", {
  state: () => ({
    categoryEntry: null as CustomerCategoryEntry | null,
    nextCategoryEntrySequence: 1,
  }),
  actions: {
    enterCategory(input: { categoryKey: string; category: string }): void {
      if (this.categoryEntry?.categoryKey === input.categoryKey) return;
      const entryId = `category-entry-${this.nextCategoryEntrySequence}`;
      this.nextCategoryEntrySequence += 1;
      this.categoryEntry = {
        entryId,
        categoryKey: input.categoryKey,
        category: input.category,
        enteredAt: new Date().toISOString(),
      };
    },
    leaveCategory(): void {
      this.categoryEntry = null;
    },
  },
});
