import { useState, useEffect } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Building2, AlertCircle, CheckCircle2, X, ChevronDown } from "lucide-react";

const COUNTRY_CODES = [
  { code: "+91", country: "India" },
  { code: "+1", country: "USA" },
  { code: "+44", country: "UK" },
  { code: "+61", country: "Australia" },
  { code: "+971", country: "UAE" },
  { code: "+81", country: "Japan" },
  { code: "+49", country: "Germany" },
];

const INDIAN_STATES = [
  "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh",
  "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jharkhand", "Karnataka",
  "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram",
  "Nagaland", "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu",
  "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal",
  "Andaman and Nicobar Islands", "Chandigarh", "Dadra and Nagar Haveli and Daman and Diu",
  "Delhi", "Jammu and Kashmir", "Ladakh", "Lakshadweep", "Puducherry"
];

const Required = () => <span className="text-red-500 ml-1">*</span>;

interface AddShopFormProps {
  onShopAdded?: (shop: any) => void;
}

export function AddShopForm({ onShopAdded }: AddShopFormProps) {
  const { toast } = useToast();
  const [submitting, setSubmitting] = useState(false);
  const [availableCategories, setAvailableCategories] = useState<string[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [categoryDropdownOpen, setCategoryDropdownOpen] = useState(false);

  const [formData, setFormData] = useState({
    name: "",
    location: "",
    city: "",
    phoneCountryCode: "+91",
    contactNumber: "",
    state: "Tamil Nadu",
    country: "India",
    pincode: "",
    gstNo: "",
    new_location: "",
    terms_and_conditions: "",
  });

  useEffect(() => {
    // Fetch vendor categories from DB
    fetch("/api/vendor-categories")
      .then(r => r.ok ? r.json() : { categories: [] })
      .then(data => {
        // Ensure we only store the category names as strings
        const cats = (data.categories || []).map((c: any) => typeof c === 'object' ? c.name : c);
        setAvailableCategories(cats);
      })
      .catch(() => setAvailableCategories([]));
  }, []);

  const handleInputChange = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const toggleCategory = (cat: string) => {
    setSelectedCategories(prev =>
      prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]
    );
  };

  const removeCategory = (cat: string) => {
    setSelectedCategories(prev => prev.filter(c => c !== cat));
  };

  const handleSubmitShop = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.name.trim()) {
      toast({ title: "Error", description: "Shop name is required", variant: "destructive" });
      return;
    }
    if (!formData.location.trim() || !formData.city.trim()) {
      toast({ title: "Error", description: "Address and city are required", variant: "destructive" });
      return;
    }
    if (!formData.contactNumber.trim()) {
      toast({ title: "Error", description: "Contact number is required", variant: "destructive" });
      return;
    }
    if (selectedCategories.length === 0) {
      toast({ title: "Error", description: "Please select at least one vendor category", variant: "destructive" });
      return;
    }

    setSubmitting(true);
    try {
      const token = localStorage.getItem("authToken");
      const response = await fetch("/api/shops", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token && { Authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify({
          ...formData,
          vendor_category: selectedCategories.join(","),
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || "Failed to create shop");
      }

      const data = await response.json();
      toast({
        title: "Success",
        description: "Shop submitted for approval! You will be notified once it's approved.",
      });

      // Reset form
      setFormData({
        name: "",
        location: "",
        city: "",
        phoneCountryCode: "+91",
        contactNumber: "",
        state: "Tamil Nadu",
        country: "India",
        pincode: "",
        gstNo: "",
        new_location: "",
        terms_and_conditions: "",
      });
      setSelectedCategories([]);

      if (onShopAdded) {
        onShopAdded(data.shop);
      }
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to create shop",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-blue-50 p-4">
      <div className="w-full max-w-2xl">
        {/* Header Section */}
        <div className="mb-8 text-center">
          <div className="flex justify-center mb-4">
            <div className="p-4 bg-blue-100 rounded-full">
              <Building2 size={32} className="text-blue-600" />
            </div>
          </div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Add Your Shop</h1>
          <p className="text-gray-500 text-sm">
            Complete your supplier profile by adding your shop details
          </p>
        </div>

        {/* Info Card */}
        <Card className="mb-6 border-blue-200 bg-blue-50">
          <CardContent className="pt-5 pb-4">
            <div className="flex gap-3">
              <AlertCircle className="text-blue-600 flex-shrink-0 mt-0.5" size={18} />
              <p className="text-sm text-gray-700">
                <strong>Shop Approval Required — </strong>
                After you submit, our team reviews your details within 24–48 hours. You'll be notified once approved.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Form Card */}
        <Card className="shadow-md border border-slate-200">
          <CardHeader className="border-b border-slate-100 pb-4">
            <CardTitle className="text-lg font-bold text-slate-800">Shop Information</CardTitle>
            <CardDescription>Provide accurate details about your shop</CardDescription>
          </CardHeader>
          <CardContent className="pt-6">
            <form onSubmit={handleSubmitShop} className="space-y-5">
              {/* Shop Name */}
              <div>
                <Label htmlFor="name" className="text-sm font-semibold text-slate-700">
                  Shop Name <Required />
                </Label>
                <Input
                  id="name"
                  type="text"
                  placeholder="Enter your shop name"
                  value={formData.name}
                  onChange={(e) => handleInputChange("name", e.target.value)}
                  required
                  className="mt-1.5"
                />
              </div>

              {/* Vendor Category Multi-Select */}
              <div>
                <Label className="text-sm font-semibold text-slate-700">
                  Vendor Category <Required />
                </Label>
                <p className="text-xs text-slate-500 mt-0.5 mb-1.5">
                  Select all categories your shop supplies. This determines which material templates are shown to you.
                </p>

                {/* Selected Tags */}
                {selectedCategories.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {selectedCategories.map(cat => (
                      <span
                        key={cat}
                        className="inline-flex items-center gap-1 px-2.5 py-1 bg-blue-100 text-blue-800 text-xs font-semibold rounded-full"
                      >
                        {cat}
                        <button
                          type="button"
                          onClick={() => removeCategory(cat)}
                          className="hover:text-blue-500 ml-0.5"
                        >
                          <X size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}

                {/* Dropdown */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setCategoryDropdownOpen(!categoryDropdownOpen)}
                    className="w-full flex items-center justify-between px-3 py-2 border border-slate-300 rounded-md bg-white text-sm text-slate-700 hover:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-300 transition"
                  >
                    <span className={selectedCategories.length === 0 ? "text-slate-400" : "text-slate-700"}>
                      {selectedCategories.length === 0
                        ? "Select vendor categories..."
                        : `${selectedCategories.length} selected`}
                    </span>
                    <ChevronDown size={16} className={`text-slate-400 transition-transform ${categoryDropdownOpen ? "rotate-180" : ""}`} />
                  </button>

                  {categoryDropdownOpen && (
                    <div className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-md shadow-lg max-h-48 overflow-y-auto">
                      {availableCategories.length === 0 ? (
                        <p className="text-center text-sm text-slate-400 py-4 italic">
                          No categories found in database
                        </p>
                      ) : (
                        availableCategories.map(cat => (
                          <button
                            key={cat}
                            type="button"
                            onClick={() => toggleCategory(cat)}
                            className={`w-full text-left px-4 py-2.5 text-sm flex items-center gap-2 hover:bg-blue-50 transition ${
                              selectedCategories.includes(cat) ? "bg-blue-50 text-blue-800 font-semibold" : "text-slate-700"
                            }`}
                          >
                            <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                              selectedCategories.includes(cat)
                                ? "bg-blue-600 border-blue-600"
                                : "border-slate-300"
                            }`}>
                              {selectedCategories.includes(cat) && (
                                <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                </svg>
                              )}
                            </span>
                            {cat}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Address and City */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="location" className="text-sm font-semibold text-slate-700">
                    Address <Required />
                  </Label>
                  <Input
                    id="location"
                    type="text"
                    placeholder="Enter shop address"
                    value={formData.location}
                    onChange={(e) => handleInputChange("location", e.target.value)}
                    required
                    className="mt-1.5"
                  />
                </div>
                <div>
                  <Label htmlFor="city" className="text-sm font-semibold text-slate-700">
                    City <Required />
                  </Label>
                  <Input
                    id="city"
                    type="text"
                    placeholder="Enter city"
                    value={formData.city}
                    onChange={(e) => handleInputChange("city", e.target.value)}
                    required
                    className="mt-1.5"
                  />
                </div>
              </div>

              {/* New Location and Pincode */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="new_location" className="text-sm font-semibold text-slate-700">Location</Label>
                  <Input
                    id="new_location"
                    type="text"
                    placeholder="Additional location info"
                    value={formData.new_location}
                    onChange={(e) => handleInputChange("new_location", e.target.value)}
                    className="mt-1.5"
                  />
                </div>
                <div>
                  <Label htmlFor="pincode" className="text-sm font-semibold text-slate-700">Pin Code</Label>
                  <Input
                    id="pincode"
                    type="text"
                    placeholder="Enter pin code"
                    value={formData.pincode}
                    onChange={(e) => handleInputChange("pincode", e.target.value)}
                    className="mt-1.5"
                  />
                </div>
              </div>

              {/* State and Country */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="state" className="text-sm font-semibold text-slate-700">State</Label>
                  <Select
                    value={formData.state}
                    onValueChange={(value) => handleInputChange("state", value)}
                  >
                    <SelectTrigger className="mt-1.5">
                      <SelectValue placeholder="Select state" />
                    </SelectTrigger>
                    <SelectContent>
                      {INDIAN_STATES.map((state) => (
                        <SelectItem key={state} value={state}>
                          {state}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="country" className="text-sm font-semibold text-slate-700">Country</Label>
                  <Input
                    id="country"
                    type="text"
                    placeholder="Country"
                    value={formData.country}
                    onChange={(e) => handleInputChange("country", e.target.value)}
                    className="mt-1.5"
                  />
                </div>
              </div>

              {/* Contact Number */}
              <div>
                <Label className="text-sm font-semibold text-slate-700">
                  Contact Number <Required />
                </Label>
                <div className="flex gap-2 mt-1.5">
                  <Select
                    value={formData.phoneCountryCode}
                    onValueChange={(value) => handleInputChange("phoneCountryCode", value)}
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {COUNTRY_CODES.map((item) => (
                        <SelectItem key={item.code} value={item.code}>
                          {item.code} {item.country}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="tel"
                    placeholder="Phone number"
                    value={formData.contactNumber}
                    onChange={(e) => handleInputChange("contactNumber", e.target.value)}
                    required
                    className="flex-1"
                  />
                </div>
              </div>

              {/* GST Number */}
              <div>
                <Label htmlFor="gstNo" className="text-sm font-semibold text-slate-700">GST Number</Label>
                <Input
                  id="gstNo"
                  type="text"
                  placeholder="Enter GST number (optional)"
                  value={formData.gstNo}
                  onChange={(e) => handleInputChange("gstNo", e.target.value)}
                  className="mt-1.5"
                />
              </div>

              {/* Terms and Conditions */}
              <div>
                <Label htmlFor="terms_and_conditions" className="text-sm font-semibold text-slate-700">Terms and Conditions</Label>
                <Input
                  id="terms_and_conditions"
                  type="text"
                  placeholder="Enter terms and conditions"
                  value={formData.terms_and_conditions}
                  onChange={(e) => handleInputChange("terms_and_conditions", e.target.value)}
                  className="mt-1.5"
                />
              </div>

              {/* Submit Button */}
              <Button
                type="submit"
                disabled={submitting}
                className="w-full bg-slate-900 hover:bg-slate-800 text-white font-semibold mt-2"
              >
                {submitting ? (
                  <>
                    <span className="animate-spin mr-2">⏳</span>
                    Submitting...
                  </>
                ) : (
                  "Submit for Approval"
                )}
              </Button>
            </form>

            {/* Bottom Info */}
            <div className="mt-5 p-4 bg-slate-50 rounded-lg border border-slate-200">
              <div className="flex gap-3">
                <CheckCircle2 className="text-green-600 flex-shrink-0 mt-0.5" size={18} />
                <p className="text-sm text-slate-600">
                  <strong>What happens next?</strong> After submitting, our approval team will review your shop details within 24–48 hours.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
